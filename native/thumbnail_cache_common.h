#pragma once

#include <bcrypt.h>

#pragma comment(lib, "bcrypt.lib")

namespace thumbnail_cache_common {

static bool sha256_prefix24(const std::string& value, std::string& output) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD objectLength = 0;
  DWORD copied = 0;
  std::vector<uint8_t> object;
  uint8_t digest[32] = {};
  bool ok = false;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) goto done;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectLength),
                        sizeof(objectLength), &copied, 0) < 0) {
    goto done;
  }
  object.resize(objectLength);
  if (BCryptCreateHash(algorithm, &hash, object.data(), objectLength, nullptr, 0, 0) < 0) goto done;
  if (BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(value.data())),
                     static_cast<ULONG>(value.size()), 0) < 0) {
    goto done;
  }
  if (BCryptFinishHash(hash, digest, sizeof(digest), 0) < 0) goto done;
  {
    static const char* hex = "0123456789abcdef";
    output.resize(24);
    for (size_t index = 0; index < 12; ++index) {
      output[index * 2] = hex[digest[index] >> 4];
      output[index * 2 + 1] = hex[digest[index] & 0x0f];
    }
  }
  ok = true;
done:
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  return ok;
}

}  // namespace thumbnail_cache_common
