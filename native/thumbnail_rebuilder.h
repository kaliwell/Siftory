#pragma once

#include <condition_variable>
#include <deque>
#include <propidl.h>
#include "image_decode_limits.h"
#include "thumbnail_cache_common.h"

namespace thumbnail_rebuilder {

static constexpr size_t kQueueCapacity = 48;
static constexpr int kTargetDimension = 256;

struct Progress {
  std::string state = "idle";
  int64_t total = 0;
  int64_t completed = 0;
  int64_t failed = 0;
  int64_t skipped = 0;
  int64_t pending = 0;
  int64_t workers = 0;
  int64_t startedAt = 0;
  int64_t finishedAt = 0;
  bool cudaRequested = false;
  bool cudaAvailable = false;
  std::string effectiveBackend = "native-cpp";
  std::string cudaError;
  std::string currentPath;
  std::string error;
};

static std::mutex g_mutex;
static std::condition_variable g_ready;
static std::condition_variable g_space;
static std::deque<std::string> g_paths;
static std::vector<std::thread> g_workers;
static std::thread g_coordinator;
static std::atomic<bool> g_running{false};
static std::atomic<bool> g_stop{false};
static std::atomic<bool> g_enumerationDone{false};
static std::atomic<int64_t> g_total{0};
static std::atomic<int64_t> g_completed{0};
static std::atomic<int64_t> g_failed{0};
static std::atomic<int64_t> g_skipped{0};
static std::atomic<int64_t> g_active{0};
static std::atomic<uint64_t> g_tempCounter{0};
static std::string g_state = "idle";
static std::string g_cacheDir;
static std::wstring g_excludedCachePath;
static std::string g_currentPath;
static std::string g_error;
static std::string g_cudaError;
static int g_cacheVersion = 5;
static int g_workerCount = 2;
static bool g_cudaRequested = false;
static bool g_cudaAvailable = false;
static int64_t g_startedAt = 0;
static int64_t g_finishedAt = 0;

static int64_t wall_clock_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

static std::wstring normalized_windows_path(const fs::path& input) {
  std::error_code error;
  fs::path absolute = fs::absolute(input, error);
  std::wstring value = (error ? input : absolute).lexically_normal().wstring();
  std::replace(value.begin(), value.end(), L'/', L'\\');
  std::transform(value.begin(), value.end(), value.begin(), towlower);
  while (value.size() > 3 && value.back() == L'\\') value.pop_back();
  return value;
}

static bool same_or_descendant(const fs::path& candidate, const std::wstring& root) {
  if (root.empty()) return false;
  const std::wstring value = normalized_windows_path(candidate);
  return value == root ||
         (value.size() > root.size() && value.compare(0, root.size(), root) == 0 &&
          value[root.size()] == L'\\');
}

static bool generated_directory_name(const fs::path& directory) {
  std::wstring name = directory.filename().wstring();
  std::transform(name.begin(), name.end(), name.begin(), towlower);
  if (!name.empty() && name.front() == L'.') return true;
  return name == L"thumbcache" || name == L"cache" || name == L"caches" ||
         name == L"code cache" || name == L"gpucache" || name == L"shadercache" ||
         name == L"node_modules" || name == L".git" || name == L"dist" ||
         name == L"build" || name == L"release" || name == L"temp" || name == L"tmp";
}

static bool is_jpeg_path(const fs::path& source) {
  std::wstring ext = source.extension().wstring();
  std::transform(ext.begin(), ext.end(), ext.begin(), towlower);
  return ext == L".jpg" || ext == L".jpeg";
}

static bool cuda_runtime_available(std::string& reason) {
  HMODULE driver = LoadLibraryW(L"nvcuda.dll");
  if (!driver) {
    reason = "NVIDIA CUDA driver library nvcuda.dll was not found";
    return false;
  }
  FreeLibrary(driver);
  const wchar_t* candidates[] = {
      L"nvjpeg64_13.dll", L"nvjpeg64_12.dll", L"nvjpeg64_11.dll"};
  for (const wchar_t* candidate : candidates) {
    HMODULE library = LoadLibraryW(candidate);
    if (library) {
      FreeLibrary(library);
      // The runtime is detected, but this build intentionally refuses to
      // claim CUDA until it was compiled with the matching nvJPEG headers.
      reason = "nvJPEG runtime found, but this binary was built without CUDA Toolkit headers";
      return false;
    }
  }
  reason = "CUDA Toolkit nvJPEG runtime is not installed; using native C++ WIC";
  return false;
}

static WICBitmapTransformOptions orientation_transform(IWICBitmapFrameDecode* frame) {
  IWICMetadataQueryReader* reader = nullptr;
  PROPVARIANT value;
  PropVariantInit(&value);
  unsigned short orientation = 1;
  if (frame && SUCCEEDED(frame->GetMetadataQueryReader(&reader)) && reader) {
    if (SUCCEEDED(reader->GetMetadataByName(L"/app1/ifd/{ushort=274}", &value))) {
      if (value.vt == VT_UI2) orientation = value.uiVal;
      else if (value.vt == VT_UI1) orientation = value.bVal;
    }
  }
  PropVariantClear(&value);
  if (reader) reader->Release();
  switch (orientation) {
    case 2: return WICBitmapTransformFlipHorizontal;
    case 3: return WICBitmapTransformRotate180;
    case 4: return WICBitmapTransformFlipVertical;
    case 5:
      return static_cast<WICBitmapTransformOptions>(WICBitmapTransformRotate90 |
                                                     WICBitmapTransformFlipHorizontal);
    case 6: return WICBitmapTransformRotate90;
    case 7:
      return static_cast<WICBitmapTransformOptions>(WICBitmapTransformRotate270 |
                                                     WICBitmapTransformFlipHorizontal);
    case 8: return WICBitmapTransformRotate270;
    default: return WICBitmapTransformRotate0;
  }
}

static bool source_modified_ms(const fs::path& source, int64_t& modifiedMs) {
  struct _stat64 st = {};
  if (_wstat64(source.c_str(), &st) != 0) return false;
  modifiedMs = static_cast<int64_t>(st.st_mtime) * 1000;
  return true;
}

static bool encode_one_to_cache(IWICImagingFactory* factory, const std::string& sourceUtf8,
                                 const std::string& cacheDir, int cacheVersion,
                                 const uint8_t* encodedData = nullptr, size_t encodedSize = 0,
                                 int64_t knownModifiedMs = 0) {
  if (!factory || cacheDir.empty()) return false;
  const fs::path source = path_from_utf8(sourceUtf8);
  int64_t modifiedMs = knownModifiedMs;
  if (modifiedMs <= 0 && !source_modified_ms(source, modifiedMs)) return false;
  std::string key;
  const std::string keyInput = "v" + std::to_string(cacheVersion) + "|" + sourceUtf8 + "|" +
                               std::to_string(modifiedMs) + "|" +
                               std::to_string(kTargetDimension);
  if (!thumbnail_cache_common::sha256_prefix24(keyInput, key)) return false;
  const fs::path finalPath = path_from_utf8(cacheDir) / utf8_to_wide(key + ".jpg");
  const fs::path tempPath =
      finalPath.wstring() + L".tmp-native-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
      std::to_wstring(g_tempCounter.fetch_add(1));

  IWICBitmapDecoder* decoder = nullptr;
  IWICBitmapFrameDecode* frame = nullptr;
  IWICBitmapSourceTransform* sourceTransform = nullptr;
  IWICBitmap* scaledDecode = nullptr;
  IWICBitmapSource* orientedSource = nullptr;
  IWICBitmapFlipRotator* rotator = nullptr;
  IWICBitmapScaler* scaler = nullptr;
  IWICFormatConverter* converter = nullptr;
  IWICStream* inputStream = nullptr;
  IWICStream* outputStream = nullptr;
  IWICBitmapEncoder* encoder = nullptr;
  IWICBitmapFrameEncode* outputFrame = nullptr;
  IPropertyBag2* properties = nullptr;
  HRESULT hr = S_OK;
  const bool canDecodeFromMemory =
      encodedData && encodedSize > 0 && encodedSize <= static_cast<size_t>(MAXDWORD);
  if (canDecodeFromMemory) {
    hr = factory->CreateStream(&inputStream);
    if (SUCCEEDED(hr))
      hr = inputStream->InitializeFromMemory(const_cast<BYTE*>(encodedData),
                                             static_cast<DWORD>(encodedSize));
    if (SUCCEEDED(hr))
      hr = factory->CreateDecoderFromStream(inputStream, nullptr,
                                            WICDecodeMetadataCacheOnDemand, &decoder);
  } else {
    hr = factory->CreateDecoderFromFilename(source.c_str(), nullptr, GENERIC_READ,
                                            WICDecodeMetadataCacheOnDemand, &decoder);
  }
  if (SUCCEEDED(hr)) hr = decoder->GetFrame(0, &frame);
  UINT width = 0, height = 0;
  if (SUCCEEDED(hr)) hr = frame->GetSize(&width, &height);
  if (SUCCEEDED(hr) && !image_decode_limits::validate(width, height, 1, false).ok)
    hr = E_INVALIDARG;
  const WICBitmapTransformOptions transform =
      SUCCEEDED(hr) ? orientation_transform(frame) : WICBitmapTransformRotate0;
  UINT displayWidth = width, displayHeight = height;
  const bool swapsAxes =
      transform == WICBitmapTransformRotate90 || transform == WICBitmapTransformRotate270 ||
      transform == (WICBitmapTransformRotate90 | WICBitmapTransformFlipHorizontal) ||
      transform == (WICBitmapTransformRotate270 | WICBitmapTransformFlipHorizontal);
  if (swapsAxes) {
    std::swap(displayWidth, displayHeight);
  }
  const double ratio = SUCCEEDED(hr)
                           ? std::min(1.0, std::min(static_cast<double>(kTargetDimension) /
                                                      std::max<UINT>(1, displayWidth),
                                                  static_cast<double>(kTargetDimension) /
                                                      std::max<UINT>(1, displayHeight)))
                           : 1.0;
  const UINT outputWidth = std::max<UINT>(1, static_cast<UINT>(std::lround(displayWidth * ratio)));
  const UINT outputHeight =
      std::max<UINT>(1, static_cast<UINT>(std::lround(displayHeight * ratio)));
  IWICBitmapSource* decodeSource = frame;
  std::vector<BYTE> scaledPixels;
  // The Windows JPEG decoder exposes IWICBitmapSourceTransform. Asking it for
  // a near-thumbnail-sized decode avoids allocating a full multi-megapixel
  // bitmap in every worker before the final WIC scale.
  if (SUCCEEDED(hr) && ratio < 1.0 &&
      SUCCEEDED(frame->QueryInterface(IID_PPV_ARGS(&sourceTransform))) && sourceTransform) {
    UINT decodeWidth = swapsAxes ? outputHeight : outputWidth;
    UINT decodeHeight = swapsAxes ? outputWidth : outputHeight;
    WICPixelFormatGUID decodeFormat = GUID_WICPixelFormat24bppBGR;
    BOOL supports = FALSE;
    HRESULT fastHr = sourceTransform->GetClosestSize(&decodeWidth, &decodeHeight);
    if (SUCCEEDED(fastHr))
      fastHr = sourceTransform->DoesSupportTransform(WICBitmapTransformRotate0, &supports);
    const uint64_t scaledBytes = static_cast<uint64_t>(decodeWidth) * decodeHeight * 3;
    if (SUCCEEDED(fastHr) && supports && decodeWidth && decodeHeight &&
        scaledBytes <= 16 * 1024 * 1024ULL) {
      scaledPixels.resize(static_cast<size_t>(scaledBytes));
      fastHr = sourceTransform->CopyPixels(
          nullptr, decodeWidth, decodeHeight, &decodeFormat, WICBitmapTransformRotate0,
          decodeWidth * 3, static_cast<UINT>(scaledPixels.size()), scaledPixels.data());
      if (SUCCEEDED(fastHr) && decodeFormat == GUID_WICPixelFormat24bppBGR)
        fastHr = factory->CreateBitmapFromMemory(
            decodeWidth, decodeHeight, GUID_WICPixelFormat24bppBGR, decodeWidth * 3,
            static_cast<UINT>(scaledPixels.size()), scaledPixels.data(), &scaledDecode);
      if (SUCCEEDED(fastHr) && scaledDecode) decodeSource = scaledDecode;
    }
  }
  if (SUCCEEDED(hr) && transform != WICBitmapTransformRotate0) {
    hr = factory->CreateBitmapFlipRotator(&rotator);
    if (SUCCEEDED(hr)) hr = rotator->Initialize(decodeSource, transform);
    if (SUCCEEDED(hr)) orientedSource = rotator;
  } else if (SUCCEEDED(hr)) {
    orientedSource = decodeSource;
  }
  if (SUCCEEDED(hr)) hr = factory->CreateBitmapScaler(&scaler);
  if (SUCCEEDED(hr))
    hr = scaler->Initialize(orientedSource, outputWidth, outputHeight,
                            WICBitmapInterpolationModeFant);
  if (SUCCEEDED(hr)) hr = factory->CreateFormatConverter(&converter);
  if (SUCCEEDED(hr))
    hr = converter->Initialize(scaler, GUID_WICPixelFormat24bppBGR,
                               WICBitmapDitherTypeNone, nullptr, 0,
                               WICBitmapPaletteTypeCustom);
  if (SUCCEEDED(hr)) hr = factory->CreateStream(&outputStream);
  if (SUCCEEDED(hr)) hr = outputStream->InitializeFromFilename(tempPath.c_str(), GENERIC_WRITE);
  if (SUCCEEDED(hr)) hr = factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &encoder);
  if (SUCCEEDED(hr)) hr = encoder->Initialize(outputStream, WICBitmapEncoderNoCache);
  if (SUCCEEDED(hr)) hr = encoder->CreateNewFrame(&outputFrame, &properties);
  if (SUCCEEDED(hr) && properties) {
    PROPBAG2 option = {};
    option.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
    VARIANT value;
    VariantInit(&value);
    value.vt = VT_R4;
    value.fltVal = 0.78f;
    properties->Write(1, &option, &value);
    VariantClear(&value);
  }
  if (SUCCEEDED(hr)) hr = outputFrame->Initialize(properties);
  if (SUCCEEDED(hr)) hr = outputFrame->SetSize(outputWidth, outputHeight);
  WICPixelFormatGUID outputFormat = GUID_WICPixelFormat24bppBGR;
  if (SUCCEEDED(hr)) hr = outputFrame->SetPixelFormat(&outputFormat);
  if (SUCCEEDED(hr)) hr = outputFrame->WriteSource(converter, nullptr);
  if (SUCCEEDED(hr)) hr = outputFrame->Commit();
  if (SUCCEEDED(hr)) hr = encoder->Commit();

  if (properties) properties->Release();
  if (outputFrame) outputFrame->Release();
  if (encoder) encoder->Release();
  if (outputStream) outputStream->Release();
  if (converter) converter->Release();
  if (scaler) scaler->Release();
  if (rotator) rotator->Release();
  if (scaledDecode) scaledDecode->Release();
  if (sourceTransform) sourceTransform->Release();
  if (frame) frame->Release();
  if (decoder) decoder->Release();
  if (inputStream) inputStream->Release();
  const bool published =
      SUCCEEDED(hr) &&
      MoveFileExW(tempPath.c_str(), finalPath.c_str(),
                  MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
  if (!published) DeleteFileW(tempPath.c_str());
  return published;
}

static void worker_loop() {
  const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  IWICImagingFactory* factory = nullptr;
  if (SUCCEEDED(com))
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                     IID_PPV_ARGS(&factory));
  while (true) {
    std::string source;
    {
      std::unique_lock<std::mutex> lock(g_mutex);
      g_ready.wait(lock, [] {
        return g_stop.load() || !g_paths.empty() || g_enumerationDone.load();
      });
      if ((g_stop.load() || g_enumerationDone.load()) && g_paths.empty()) break;
      if (g_paths.empty()) continue;
      source = std::move(g_paths.front());
      g_paths.pop_front();
      g_active.fetch_add(1);
      g_currentPath = source;
    }
    g_space.notify_one();
    if (!g_stop.load() && encode_one_to_cache(factory, source, g_cacheDir, g_cacheVersion))
      g_completed.fetch_add(1);
    else if (!g_stop.load()) g_failed.fetch_add(1);
    g_active.fetch_sub(1);
  }
  if (factory) factory->Release();
  if (SUCCEEDED(com)) CoUninitialize();
}

static bool enqueue_path(const fs::path& path) {
  std::unique_lock<std::mutex> lock(g_mutex);
  g_space.wait(lock, [] { return g_stop.load() || g_paths.size() < kQueueCapacity; });
  if (g_stop.load()) return false;
  g_paths.push_back(wide_to_utf8(path.wstring()));
  g_total.fetch_add(1);
  lock.unlock();
  g_ready.notify_one();
  return true;
}

static void enumerate_root(const fs::path& root) {
  std::error_code error;
  if (same_or_descendant(root, g_excludedCachePath)) {
    g_skipped.fetch_add(1);
    return;
  }
  if (fs::is_regular_file(root, error)) {
    if (is_jpeg_path(root)) enqueue_path(root);
    else g_skipped.fetch_add(1);
    return;
  }
  fs::recursive_directory_iterator iterator(
      root, fs::directory_options::skip_permission_denied, error);
  const fs::recursive_directory_iterator end;
  while (!g_stop.load() && iterator != end) {
    if (error) {
      error.clear();
      iterator.increment(error);
      continue;
    }
    if (iterator->is_directory(error)) {
      if (same_or_descendant(iterator->path(), g_excludedCachePath) ||
          generated_directory_name(iterator->path())) {
        iterator.disable_recursion_pending();
        g_skipped.fetch_add(1);
      }
    } else if (iterator->is_regular_file(error) &&
               !same_or_descendant(iterator->path(), g_excludedCachePath)) {
      if (is_jpeg_path(iterator->path())) {
        if (!enqueue_path(iterator->path())) break;
      }
    }
    iterator.increment(error);
  }
}

static void coordinator_loop(std::vector<std::string> roots) {
  try {
    for (const auto& root : roots) {
      if (g_stop.load()) break;
      enumerate_root(path_from_utf8(root));
    }
  } catch (const std::exception& exception) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_error = exception.what();
  } catch (...) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_error = "Native thumbnail enumeration failed";
  }
  g_enumerationDone.store(true);
  g_ready.notify_all();
  for (auto& worker : g_workers)
    if (worker.joinable()) worker.join();
  g_workers.clear();
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_finishedAt = wall_clock_ms();
    g_state = !g_error.empty() ? "error" : "done";
    g_currentPath.clear();
  }
  g_running.store(false);
}

static bool start(const std::vector<std::string>& roots, const std::string& cacheDir,
                  int cacheVersion, int workers, bool requestCuda, std::string& error) {
  if (g_running.load()) {
    error = "Native thumbnail rebuild is already running";
    return false;
  }
  if (g_coordinator.joinable()) g_coordinator.join();
  std::error_code directoryError;
  fs::create_directories(path_from_utf8(cacheDir), directoryError);
  if (directoryError || roots.empty() || cacheDir.empty()) {
    error = "Invalid native thumbnail rebuild paths";
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_paths.clear();
    g_cacheDir = cacheDir;
    g_excludedCachePath = normalized_windows_path(path_from_utf8(cacheDir));
    g_cacheVersion = std::max(1, cacheVersion);
    g_workerCount = std::clamp(workers, 2, 20);
    g_cudaRequested = requestCuda;
    g_cudaAvailable = requestCuda && cuda_runtime_available(g_cudaError);
    if (!requestCuda) g_cudaError.clear();
    g_state = "running";
    g_currentPath = "Enumerating JPEG sources...";
    g_error.clear();
    g_startedAt = wall_clock_ms();
    g_finishedAt = 0;
  }
  g_stop.store(false);
  g_enumerationDone.store(false);
  g_total.store(0);
  g_completed.store(0);
  g_failed.store(0);
  g_skipped.store(0);
  g_active.store(0);
  g_running.store(true);
  g_workers.clear();
  for (int index = 0; index < g_workerCount; ++index)
    g_workers.emplace_back(worker_loop);
  g_coordinator = std::thread(coordinator_loop, roots);
  return true;
}

static void request_stop() {
  g_stop.store(true);
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_state = g_running.load() ? "stopping" : g_state;
    g_paths.clear();
  }
  g_ready.notify_all();
  g_space.notify_all();
}

static void shutdown() {
  request_stop();
  if (g_coordinator.joinable()) g_coordinator.join();
  for (auto& worker : g_workers)
    if (worker.joinable()) worker.join();
  g_workers.clear();
  g_running.store(false);
}

static Progress progress() {
  Progress result;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    result.state = g_state;
    result.currentPath = g_currentPath;
    result.error = g_error;
    result.cudaError = g_cudaError;
    result.startedAt = g_startedAt;
    result.finishedAt = g_finishedAt;
    result.workers = g_workerCount;
    result.cudaRequested = g_cudaRequested;
    result.cudaAvailable = g_cudaAvailable;
  }
  result.total = g_total.load();
  result.completed = g_completed.load();
  result.failed = g_failed.load();
  result.skipped = g_skipped.load();
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    result.pending = static_cast<int64_t>(g_paths.size()) + g_active.load();
  }
  result.effectiveBackend = result.cudaAvailable ? "cuda" : "native-cpp";
  return result;
}

}  // namespace thumbnail_rebuilder
