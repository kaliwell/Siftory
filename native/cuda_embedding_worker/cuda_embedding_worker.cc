#include <fcntl.h>
#include <io.h>
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <onnxruntime_cxx_api.h>

namespace {

constexpr std::uint32_t kMagic = 0x4d454346;  // FCEM in little-endian byte order.
constexpr std::uint16_t kProtocolVersion = 1;
constexpr std::uint32_t kMaxPayloadBytes = 256U * 1024U * 1024U;
constexpr std::uint16_t kMaxTensorCount = 8;
constexpr std::uint8_t kMaxRank = 8;
constexpr std::uint64_t kMaxTensorValues = 64ULL * 1024ULL * 1024ULL;

enum class MessageType : std::uint16_t {
  kHello = 1,
  kInfer = 2,
  kResult = 3,
  kError = 4,
  kPing = 5,
  kPong = 6,
  kShutdown = 7,
};

enum class TensorDtype : std::uint8_t {
  kFloat32 = 1,
  kInt64 = 2,
};

#pragma pack(push, 1)
struct MessageHeader {
  std::uint32_t magic;
  std::uint16_t version;
  std::uint16_t type;
  std::uint32_t request_id;
  std::uint32_t payload_bytes;
};
#pragma pack(pop)

static_assert(sizeof(MessageHeader) == 16);

struct Arguments {
  std::wstring model_path;
  std::wstring runtime_dir;
  std::vector<std::wstring> dll_directories;
  std::string model_id;
  std::string output_name;
};

struct InputTensor {
  std::string name;
  TensorDtype dtype;
  std::vector<std::int64_t> dimensions;
  std::vector<float> float_values;
  std::vector<std::int64_t> int64_values;
};

std::string wide_to_utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                       static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) throw std::runtime_error("failed to convert a command-line argument to UTF-8");
  std::string output(static_cast<std::size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), output.data(), size, nullptr, nullptr) <= 0) {
    throw std::runtime_error("failed to convert a command-line argument to UTF-8");
  }
  return output;
}

std::string json_escape(const std::string& value) {
  std::ostringstream stream;
  for (const unsigned char character : value) {
    switch (character) {
      case '\\': stream << "\\\\"; break;
      case '"': stream << "\\\""; break;
      case '\b': stream << "\\b"; break;
      case '\f': stream << "\\f"; break;
      case '\n': stream << "\\n"; break;
      case '\r': stream << "\\r"; break;
      case '\t': stream << "\\t"; break;
      default:
        if (character < 0x20) {
          constexpr char hex[] = "0123456789abcdef";
          stream << "\\u00" << hex[(character >> 4) & 0xf] << hex[character & 0xf];
        } else {
          stream << static_cast<char>(character);
        }
    }
  }
  return stream.str();
}

Arguments parse_arguments(int argc, wchar_t** argv) {
  Arguments arguments;
  for (int index = 1; index < argc; ++index) {
    const std::wstring name = argv[index];
    if (index + 1 >= argc) throw std::runtime_error("every worker option requires a value");
    const std::wstring value = argv[++index];
    if (name == L"--model-path") arguments.model_path = value;
    else if (name == L"--runtime-dir") arguments.runtime_dir = value;
    else if (name == L"--dll-dir") arguments.dll_directories.push_back(value);
    else if (name == L"--model-id") arguments.model_id = wide_to_utf8(value);
    else if (name == L"--output-name") arguments.output_name = wide_to_utf8(value);
    else throw std::runtime_error("unknown worker option: " + wide_to_utf8(name));
  }
  if (arguments.model_path.empty() || arguments.runtime_dir.empty() || arguments.model_id.empty() ||
      arguments.output_name.empty()) {
    throw std::runtime_error("model path, runtime dir, model id, and output name are required");
  }
  if (arguments.model_id == "dino") {
    if (arguments.output_name != "last_hidden_state") {
      throw std::runtime_error("DINO output name is not allowlisted");
    }
  } else if (arguments.model_id == "clip-image") {
    if (arguments.output_name != "image_embeds") {
      throw std::runtime_error("CLIP image output name is not allowlisted");
    }
  } else {
    throw std::runtime_error("model id is not allowlisted");
  }
  return arguments;
}

bool read_exact(void* destination, std::size_t bytes) {
  auto* output = static_cast<std::uint8_t*>(destination);
  std::size_t offset = 0;
  while (offset < bytes) {
    const std::size_t remaining = bytes - offset;
    const unsigned int chunk = static_cast<unsigned int>(
        std::min<std::size_t>(remaining, std::numeric_limits<unsigned int>::max()));
    const int read = _read(_fileno(stdin), output + offset, chunk);
    if (read == 0) return false;
    if (read < 0) throw std::runtime_error("failed to read worker stdin");
    offset += static_cast<std::size_t>(read);
  }
  return true;
}

void write_exact(const void* source, std::size_t bytes) {
  const auto* input = static_cast<const std::uint8_t*>(source);
  std::size_t offset = 0;
  while (offset < bytes) {
    const std::size_t remaining = bytes - offset;
    const unsigned int chunk = static_cast<unsigned int>(
        std::min<std::size_t>(remaining, std::numeric_limits<unsigned int>::max()));
    const int written = _write(_fileno(stdout), input + offset, chunk);
    if (written <= 0) throw std::runtime_error("failed to write worker stdout");
    offset += static_cast<std::size_t>(written);
  }
}

void write_message(MessageType type, std::uint32_t request_id,
                   const std::vector<std::uint8_t>& payload) {
  if (payload.size() > kMaxPayloadBytes) throw std::runtime_error("worker response is too large");
  const MessageHeader header{kMagic, kProtocolVersion, static_cast<std::uint16_t>(type), request_id,
                             static_cast<std::uint32_t>(payload.size())};
  write_exact(&header, sizeof(header));
  if (!payload.empty()) write_exact(payload.data(), payload.size());
}

void write_json_message(MessageType type, std::uint32_t request_id, const std::string& json) {
  write_message(type, request_id, std::vector<std::uint8_t>(json.begin(), json.end()));
}

class PayloadReader {
 public:
  explicit PayloadReader(const std::vector<std::uint8_t>& payload) : payload_(payload) {}

  template <typename T>
  T read_scalar() {
    static_assert(std::is_trivially_copyable_v<T>);
    if (offset_ > payload_.size() || sizeof(T) > payload_.size() - offset_) {
      throw std::runtime_error("truncated inference payload");
    }
    T value{};
    std::memcpy(&value, payload_.data() + offset_, sizeof(T));
    offset_ += sizeof(T);
    return value;
  }

  std::string read_string(std::size_t length) {
    if (offset_ > payload_.size() || length > payload_.size() - offset_) {
      throw std::runtime_error("truncated inference tensor name");
    }
    std::string value(reinterpret_cast<const char*>(payload_.data() + offset_), length);
    offset_ += length;
    return value;
  }

  void read_bytes(void* destination, std::size_t length) {
    if (offset_ > payload_.size() || length > payload_.size() - offset_) {
      throw std::runtime_error("truncated inference tensor data");
    }
    std::memcpy(destination, payload_.data() + offset_, length);
    offset_ += length;
  }

  bool finished() const { return offset_ == payload_.size(); }

 private:
  const std::vector<std::uint8_t>& payload_;
  std::size_t offset_ = 0;
};

std::uint64_t checked_value_count(const std::vector<std::int64_t>& dimensions) {
  std::uint64_t count = 1;
  for (const std::int64_t dimension : dimensions) {
    if (dimension <= 0) throw std::runtime_error("tensor dimensions must be positive");
    const auto unsigned_dimension = static_cast<std::uint64_t>(dimension);
    if (count > kMaxTensorValues / unsigned_dimension) {
      throw std::runtime_error("tensor dimensions exceed the value limit");
    }
    count *= unsigned_dimension;
  }
  return count;
}

std::vector<InputTensor> parse_input_tensors(const std::vector<std::uint8_t>& payload) {
  PayloadReader reader(payload);
  const std::uint16_t tensor_count = reader.read_scalar<std::uint16_t>();
  if (tensor_count == 0 || tensor_count > kMaxTensorCount) {
    throw std::runtime_error("tensor count is outside the protocol limit");
  }
  std::vector<InputTensor> tensors;
  tensors.reserve(tensor_count);
  std::unordered_set<std::string> names;
  for (std::uint16_t index = 0; index < tensor_count; ++index) {
    const std::uint16_t name_length = reader.read_scalar<std::uint16_t>();
    const TensorDtype dtype = static_cast<TensorDtype>(reader.read_scalar<std::uint8_t>());
    const std::uint8_t rank = reader.read_scalar<std::uint8_t>();
    static_cast<void>(reader.read_scalar<std::uint16_t>());  // Reserved.
    if (name_length == 0 || name_length > 128 || rank == 0 || rank > kMaxRank) {
      throw std::runtime_error("tensor name length or rank is outside the protocol limit");
    }
    InputTensor tensor{reader.read_string(name_length), dtype, {}, {}, {}};
    if (!names.insert(tensor.name).second) throw std::runtime_error("duplicate input tensor name");
    tensor.dimensions.reserve(rank);
    for (std::uint8_t dimension_index = 0; dimension_index < rank; ++dimension_index) {
      tensor.dimensions.push_back(reader.read_scalar<std::int64_t>());
    }
    const std::uint64_t value_count = checked_value_count(tensor.dimensions);
    const std::uint64_t data_bytes = reader.read_scalar<std::uint64_t>();
    std::uint64_t expected_bytes = 0;
    if (dtype == TensorDtype::kFloat32) expected_bytes = value_count * sizeof(float);
    else if (dtype == TensorDtype::kInt64) expected_bytes = value_count * sizeof(std::int64_t);
    else throw std::runtime_error("unsupported input tensor dtype");
    if (data_bytes != expected_bytes || data_bytes > kMaxPayloadBytes) {
      throw std::runtime_error("input tensor byte length is invalid");
    }
    if (dtype == TensorDtype::kFloat32) {
      tensor.float_values.resize(static_cast<std::size_t>(value_count));
      reader.read_bytes(tensor.float_values.data(), static_cast<std::size_t>(data_bytes));
    } else {
      tensor.int64_values.resize(static_cast<std::size_t>(value_count));
      reader.read_bytes(tensor.int64_values.data(), static_cast<std::size_t>(data_bytes));
    }
    tensors.push_back(std::move(tensor));
  }
  if (!reader.finished()) throw std::runtime_error("inference payload contains trailing bytes");
  return tensors;
}

template <typename T>
void append_scalar(std::vector<std::uint8_t>& output, T value) {
  static_assert(std::is_trivially_copyable_v<T>);
  const auto* bytes = reinterpret_cast<const std::uint8_t*>(&value);
  output.insert(output.end(), bytes, bytes + sizeof(T));
}

std::vector<std::uint8_t> serialize_float_output(const Ort::Value& output) {
  if (!output.IsTensor()) throw std::runtime_error("model output is not a tensor");
  const Ort::TensorTypeAndShapeInfo info = output.GetTensorTypeAndShapeInfo();
  if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
    throw std::runtime_error("model output dtype is not float32");
  }
  const std::vector<std::int64_t> dimensions = info.GetShape();
  if (dimensions.empty() || dimensions.size() > kMaxRank) {
    throw std::runtime_error("model output rank is outside the protocol limit");
  }
  const std::uint64_t value_count = checked_value_count(dimensions);
  const std::uint64_t data_bytes = value_count * sizeof(float);
  if (data_bytes > kMaxPayloadBytes) throw std::runtime_error("model output is too large");
  std::vector<std::uint8_t> payload;
  payload.reserve(4 + dimensions.size() * sizeof(std::int64_t) + sizeof(std::uint64_t) +
                  static_cast<std::size_t>(data_bytes));
  append_scalar(payload, static_cast<std::uint8_t>(TensorDtype::kFloat32));
  append_scalar(payload, static_cast<std::uint8_t>(dimensions.size()));
  append_scalar(payload, static_cast<std::uint16_t>(0));
  for (const std::int64_t dimension : dimensions) append_scalar(payload, dimension);
  append_scalar(payload, data_bytes);
  const float* data = output.GetTensorData<float>();
  const auto* bytes = reinterpret_cast<const std::uint8_t*>(data);
  payload.insert(payload.end(), bytes, bytes + data_bytes);
  return payload;
}

class CudaSession {
 public:
  explicit CudaSession(const Arguments& arguments)
      : environment_(ORT_LOGGING_LEVEL_WARNING, "floating-clock-cuda-worker"),
        model_id_(arguments.model_id),
        output_name_(arguments.output_name) {
    Ort::SessionOptions options;
    options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    Ort::CUDAProviderOptions cuda_options;
    cuda_options.Update({
        {"device_id", "0"},
        {"do_copy_in_default_stream", "1"},
        {"gpu_mem_limit", "3221225472"},
        {"use_tf32", "0"},
    });
    options.AppendExecutionProvider_CUDA_V2(*cuda_options);
    session_ = std::make_unique<Ort::Session>(environment_, arguments.model_path.c_str(), options);

    Ort::AllocatorWithDefaultOptions allocator;
    const std::size_t input_count = session_->GetInputCount();
    for (std::size_t index = 0; index < input_count; ++index) {
      input_names_.push_back(session_->GetInputNameAllocated(index, allocator).get());
    }
    const std::size_t output_count = session_->GetOutputCount();
    bool output_found = false;
    for (std::size_t index = 0; index < output_count; ++index) {
      if (session_->GetOutputNameAllocated(index, allocator).get() == output_name_) output_found = true;
    }
    if (!output_found) throw std::runtime_error("configured output is not exposed by the model");
  }

  std::vector<std::uint8_t> run(std::vector<InputTensor>& tensors) {
    if (tensors.size() != input_names_.size()) {
      throw std::runtime_error("inference request tensor count does not match the model");
    }
    std::unordered_map<std::string, InputTensor*> by_name;
    for (InputTensor& tensor : tensors) by_name.emplace(tensor.name, &tensor);

    const Ort::MemoryInfo memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    std::vector<Ort::Value> values;
    std::vector<const char*> names;
    values.reserve(input_names_.size());
    names.reserve(input_names_.size());
    for (const std::string& input_name : input_names_) {
      const auto iterator = by_name.find(input_name);
      if (iterator == by_name.end()) throw std::runtime_error("required model input is missing");
      InputTensor& tensor = *iterator->second;
      names.push_back(input_name.c_str());
      if (tensor.dtype == TensorDtype::kFloat32) {
        values.push_back(Ort::Value::CreateTensor<float>(
            memory, tensor.float_values.data(), tensor.float_values.size(), tensor.dimensions.data(),
            tensor.dimensions.size()));
      } else {
        values.push_back(Ort::Value::CreateTensor<std::int64_t>(
            memory, tensor.int64_values.data(), tensor.int64_values.size(), tensor.dimensions.data(),
            tensor.dimensions.size()));
      }
    }
    const char* output_name = output_name_.c_str();
    std::vector<Ort::Value> outputs = session_->Run(Ort::RunOptions{nullptr}, names.data(),
                                                     values.data(), values.size(), &output_name, 1);
    if (outputs.size() != 1) throw std::runtime_error("model returned an unexpected output count");
    const std::vector<std::int64_t> output_shape =
        outputs.front().GetTensorTypeAndShapeInfo().GetShape();
    const std::size_t expected_rank = model_id_ == "dino" ? 3 : 2;
    const std::int64_t expected_dimension = model_id_ == "dino" ? 768 : 512;
    if (output_shape.size() != expected_rank || output_shape.back() != expected_dimension) {
      throw std::runtime_error("model output shape does not match the allowlisted model");
    }
    const auto pixel_values = by_name.find("pixel_values");
    if (pixel_values == by_name.end() || pixel_values->second->dimensions.empty() ||
        output_shape.front() != pixel_values->second->dimensions.front()) {
      throw std::runtime_error("model output batch does not match pixel_values");
    }
    return serialize_float_output(outputs.front());
  }

 private:
  Ort::Env environment_;
  std::unique_ptr<Ort::Session> session_;
  std::string model_id_;
  std::string output_name_;
  std::vector<std::string> input_names_;
};

std::string provider_list_json() {
  const std::vector<std::string> providers = Ort::GetAvailableProviders();
  std::ostringstream stream;
  stream << '[';
  for (std::size_t index = 0; index < providers.size(); ++index) {
    if (index > 0) stream << ',';
    stream << '"' << json_escape(providers[index]) << '"';
  }
  stream << ']';
  return stream.str();
}

void configure_dll_search(const std::wstring& runtime_dir,
                          const std::vector<std::wstring>& dll_directories) {
  if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_USER_DIRS)) {
    throw std::runtime_error("failed to restrict DLL search directories");
  }
  if (AddDllDirectory(runtime_dir.c_str()) == nullptr) {
    throw std::runtime_error("failed to add the private CUDA runtime directory");
  }
  for (const std::wstring& directory : dll_directories) {
    if (AddDllDirectory(directory.c_str()) == nullptr) {
      throw std::runtime_error("failed to add a private CUDA dependency directory");
    }
  }
}

int run_worker(const Arguments& arguments) {
  configure_dll_search(arguments.runtime_dir, arguments.dll_directories);
  CudaSession session(arguments);
  const std::string hello =
      "{\"protocolVersion\":1,\"provider\":\"cuda\",\"deviceId\":0,\"model\":\"" +
      json_escape(arguments.model_id) + "\",\"ortVersion\":\"" +
      json_escape(Ort::GetVersionString()) + "\",\"availableProviders\":" +
      provider_list_json() + "}";
  write_json_message(MessageType::kHello, 0, hello);

  for (;;) {
    MessageHeader header{};
    if (!read_exact(&header, sizeof(header))) return 0;
    if (header.magic != kMagic || header.version != kProtocolVersion ||
        header.payload_bytes > kMaxPayloadBytes) {
      throw std::runtime_error("invalid worker message header");
    }
    std::vector<std::uint8_t> payload(header.payload_bytes);
    if (!payload.empty() && !read_exact(payload.data(), payload.size())) {
      throw std::runtime_error("truncated worker message payload");
    }
    const MessageType type = static_cast<MessageType>(header.type);
    if (type == MessageType::kShutdown) return 0;
    if (type == MessageType::kPing) {
      write_message(MessageType::kPong, header.request_id, {});
      continue;
    }
    if (type != MessageType::kInfer) {
      write_json_message(MessageType::kError, header.request_id,
                         "{\"error\":\"unsupported message type\"}");
      continue;
    }
    try {
      std::vector<InputTensor> tensors = parse_input_tensors(payload);
      write_message(MessageType::kResult, header.request_id, session.run(tensors));
    } catch (const std::exception& error) {
      write_json_message(MessageType::kError, header.request_id,
                         "{\"error\":\"" + json_escape(error.what()) + "\"}");
    }
  }
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 ||
        _setmode(_fileno(stdout), _O_BINARY) == -1) {
      throw std::runtime_error("failed to configure binary stdio");
    }
    return run_worker(parse_arguments(argc, argv));
  } catch (const Ort::Exception& error) {
    std::cerr << "ONNX Runtime error: " << error.what() << '\n';
    return 2;
  } catch (const std::exception& error) {
    std::cerr << "CUDA worker error: " << error.what() << '\n';
    return 2;
  }
}
