#pragma once

#include <cstdio>
#include <fstream>
#include <iterator>
#include <sstream>
#include <string>
#include <iostream>

namespace tend::cli {

inline bool read_file(const std::string& path, std::string& out) {
  if (path == "-") {
    std::ostringstream ss;
    ss << std::cin.rdbuf();
    out = ss.str();
    return true;
  }
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
  return !f.bad();
}

// Writes next to the target and renames, so readers never see a partial file.
inline bool write_file(const std::string& path, const void* data, size_t n) {
  if (path == "-") {
    std::fwrite(data, 1, n, stdout);
    return std::fflush(stdout) == 0;
  }
  std::string tmp = path + ".tmp";
  std::FILE* f = std::fopen(tmp.c_str(), "wb");
  if (!f) return false;
  bool ok = std::fwrite(data, 1, n, f) == n;
  ok = (std::fclose(f) == 0) && ok;
  if (!ok || std::rename(tmp.c_str(), path.c_str()) != 0) {
    std::remove(tmp.c_str());
    return false;
  }
  return true;
}

}  // namespace tend::cli
