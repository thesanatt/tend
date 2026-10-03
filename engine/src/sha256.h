// SHA-256 per FIPS 180-4.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace tend {

class Sha256 {
 public:
  Sha256();
  void update(const void* data, size_t len);
  // Finishes a copy so the running state can keep absorbing input.
  void digest(uint8_t out[32]) const;

 private:
  void compress(const uint8_t* block);

  uint32_t h_[8];
  uint64_t total_ = 0;
  uint8_t buf_[64];
  size_t buffered_ = 0;
};

void sha256(const void* data, size_t len, uint8_t out[32]);
std::string to_hex(const uint8_t* bytes, size_t n);
bool from_hex(const char* s, size_t n, uint8_t* out);  // n hex chars -> n/2 bytes

}  // namespace tend
