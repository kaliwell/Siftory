#include "rotating_logger.h"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <thread>

namespace fs = std::filesystem;

namespace rotating_logger {
namespace {

constexpr std::uintmax_t kDefaultMaxBytes = 16ULL * 1024ULL * 1024ULL;
constexpr int kDefaultBackupCount = 2;
constexpr std::uintmax_t kMinimumTestMaxBytes = 256;
constexpr std::uintmax_t kMaximumMaxBytes = 256ULL * 1024ULL * 1024ULL;
constexpr std::size_t kMaximumMessageBytes = 4096;

std::mutex g_log_mutex;
bool g_privacy_warning_written = false;

bool env_enabled(const char* name) {
  const char* value = std::getenv(name);
  return value != nullptr && std::string(value) == "1";
}

std::uintmax_t bounded_env_bytes(const char* name, std::uintmax_t fallback) {
  const char* value = std::getenv(name);
  if (value == nullptr) return fallback;
  try {
    const auto parsed = std::stoull(value);
    return std::clamp<std::uintmax_t>(parsed, kMinimumTestMaxBytes, kMaximumMaxBytes);
  } catch (...) {
    return fallback;
  }
}

int bounded_env_int(const char* name, int fallback, int minimum, int maximum) {
  const char* value = std::getenv(name);
  if (value == nullptr) return fallback;
  try {
    return std::clamp(std::stoi(value), minimum, maximum);
  } catch (...) {
    return fallback;
  }
}

Policy load_policy() {
  const bool test_mode = env_enabled("FLOATING_CLOCK_NATIVE_LOG_TEST");
  const char* app_data = std::getenv("APPDATA");
  fs::path directory =
      fs::path(app_data != nullptr ? app_data : "C:\\Users\\Public") /
      "floating-clock-electron";
  if (test_mode) {
    const char* test_directory = std::getenv("FLOATING_CLOCK_NATIVE_LOG_DIR");
    if (test_directory != nullptr && *test_directory != '\0') directory = fs::path(test_directory);
  }

  return {
      (directory / "image-search-scan.log").string(),
      test_mode ? bounded_env_bytes("FLOATING_CLOCK_NATIVE_LOG_MAX_BYTES", kDefaultMaxBytes)
                : kDefaultMaxBytes,
      test_mode ? bounded_env_int("FLOATING_CLOCK_NATIVE_LOG_BACKUPS", kDefaultBackupCount, 1, 5)
                : kDefaultBackupCount,
      env_enabled("IMAGESEARCH_VERBOSE_LOG") && env_enabled("IMAGESEARCH_VERBOSE_PATHS"),
  };
}

Policy& current_policy() {
  static Policy value = load_policy();
  return value;
}

std::string normalize_message(std::string message) {
  std::replace(message.begin(), message.end(), '\r', ' ');
  std::replace(message.begin(), message.end(), '\n', ' ');
  if (!current_policy().verbose_paths) {
    std::size_t absolute_path = std::string::npos;
    for (std::size_t index = 0; index + 2 < message.size(); ++index) {
      const bool drive_path =
          std::isalpha(static_cast<unsigned char>(message[index])) &&
          message[index + 1] == ':' &&
          (message[index + 2] == '\\' || message[index + 2] == '/');
      const bool unc_path = message[index] == '\\' && message[index + 1] == '\\';
      if (drive_path || unc_path) {
        absolute_path = index;
        break;
      }
    }
    if (absolute_path != std::string::npos) {
      message.replace(absolute_path, std::string::npos, "<absolute-path-redacted>");
    }
  }
  if (message.size() > kMaximumMessageBytes) {
    message.resize(kMaximumMessageBytes);
    message += " [truncated]";
  }
  return message;
}

std::string timestamped_line(const std::string& message) {
  const auto now = std::chrono::system_clock::now();
  const auto time = std::chrono::system_clock::to_time_t(now);
  std::tm local_time{};
  localtime_s(&local_time, &time);
  std::ostringstream line;
  line << '[' << std::put_time(&local_time, "%Y-%m-%d %H:%M:%S") << "]["
       << std::this_thread::get_id() << "] " << normalize_message(message) << '\n';
  return line.str();
}

void rotate_if_needed(const Policy& value, std::uintmax_t incoming_bytes) {
  const fs::path log_path(value.log_path);
  std::error_code error;
  const auto current_bytes = fs::exists(log_path, error) && !error
                                 ? fs::file_size(log_path, error)
                                 : 0;
  if (error || current_bytes + incoming_bytes <= value.max_bytes) return;

  const fs::path oldest = value.log_path + "." + std::to_string(value.backup_count);
  fs::remove(oldest, error);
  error.clear();
  for (int index = value.backup_count - 1; index >= 1; --index) {
    const fs::path source = value.log_path + "." + std::to_string(index);
    const fs::path target = value.log_path + "." + std::to_string(index + 1);
    if (!fs::exists(source, error) || error) {
      error.clear();
      continue;
    }
    fs::rename(source, target, error);
    if (error) return;
  }
  fs::rename(log_path, value.log_path + ".1", error);
}

void write_locked(const std::string& message) {
  const Policy& value = current_policy();
  const std::string line = timestamped_line(message);
  const fs::path log_path(value.log_path);
  std::error_code error;
  fs::create_directories(log_path.parent_path(), error);
  if (error) return;
  rotate_if_needed(value, line.size());
  if (env_enabled("FLOATING_CLOCK_NATIVE_LOG_TEST") &&
      env_enabled("FLOATING_CLOCK_NATIVE_LOG_FORCE_WRITE_FAILURE")) {
    return;
  }
  std::ofstream stream(log_path, std::ios::app | std::ios::binary);
  if (!stream) return;
  stream.write(line.data(), static_cast<std::streamsize>(line.size()));
  stream.flush();
}

std::uint64_t path_fingerprint(const std::string& value) {
  std::uint64_t hash = 1469598103934665603ULL;
  for (unsigned char byte : value) {
    hash ^= byte;
    hash *= 1099511628211ULL;
  }
  return hash;
}

}  // namespace

void write(const std::string& message) {
  try {
    std::lock_guard<std::mutex> lock(g_log_mutex);
    const Policy& value = current_policy();
    if (value.verbose_paths && !g_privacy_warning_written) {
      g_privacy_warning_written = true;
      write_locked(
          "PRIVACY_WARNING absolute paths enabled by explicit "
          "IMAGESEARCH_VERBOSE_PATHS=1");
    }
    write_locked(message);
  } catch (...) {
    // Diagnostics must never interrupt scanning.
  }
}

std::string path_value(const std::string& absolute_path) {
  if (current_policy().verbose_paths) return absolute_path;
  std::ostringstream value;
  value << "<path#" << std::hex << std::setw(16) << std::setfill('0')
        << path_fingerprint(absolute_path) << '>';
  return value.str();
}

Policy policy() { return current_policy(); }

}  // namespace rotating_logger
