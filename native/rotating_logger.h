#pragma once

#include <cstdint>
#include <string>

namespace rotating_logger {

struct Policy {
  std::string log_path;
  std::uintmax_t max_bytes;
  int backup_count;
  bool verbose_paths;
};

void write(const std::string& message);
std::string path_value(const std::string& absolute_path);
Policy policy();

}  // namespace rotating_logger
