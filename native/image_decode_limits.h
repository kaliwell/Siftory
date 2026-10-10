#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>

namespace image_decode_limits {

static constexpr uint64_t kMaxDimension = 32768;
static constexpr uint64_t kMaxSourcePixels = 100000000;
static constexpr uint64_t kMaxDecodedBytes = 256ULL * 1024ULL * 1024ULL;

struct Validation {
  bool ok = false;
  const char* reason = "invalid image dimensions";
  size_t pixels = 0;
  size_t decodedBytes = 0;
};

inline Validation validate(uint64_t width, uint64_t height, uint64_t channels,
                           bool enforceDecodedBudget) {
  Validation result;
  if (width == 0 || height == 0 || channels == 0 || channels > 4 ||
      width > kMaxDimension || height > kMaxDimension) {
    result.reason = "image dimensions exceed the safety limit";
    return result;
  }
  if (height > std::numeric_limits<size_t>::max() / width) {
    result.reason = "image pixel count overflows the platform limit";
    return result;
  }
  const size_t pixels = static_cast<size_t>(width * height);
  if (pixels > kMaxSourcePixels) {
    result.reason = "image pixel count exceeds the safety budget";
    return result;
  }
  if (channels > std::numeric_limits<size_t>::max() / pixels) {
    result.reason = "decoded image size overflows the platform limit";
    return result;
  }
  const size_t decodedBytes = pixels * static_cast<size_t>(channels);
  if (enforceDecodedBudget && decodedBytes > kMaxDecodedBytes) {
    result.reason = "decoded image memory exceeds the safety budget";
    return result;
  }
  result.ok = true;
  result.reason = "";
  result.pixels = pixels;
  result.decodedBytes = decodedBytes;
  return result;
}

}  // namespace image_decode_limits
