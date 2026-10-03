// tdis: print a law image as an assembly listing.
#include <cstdio>
#include <cstring>
#include <string>

#include "cli_util.h"
#include "tend/tend.h"

int main(int argc, char** argv) {
  std::string in, out = "-";
  for (int i = 1; i < argc; i++) {
    if (!std::strcmp(argv[i], "-o") && i + 1 < argc) out = argv[++i];
    else if (in.empty()) in = argv[i];
    else in.clear();
  }
  if (in.empty()) {
    std::fprintf(stderr, "usage: tdis <ST.tlaw> [-o listing.asm]\n");
    return 2;
  }
  std::string img;
  if (!tend::cli::read_file(in, img)) {
    std::fprintf(stderr, "tdis: cannot read %s\n", in.c_str());
    return 1;
  }
  char* text = tend_disasm(reinterpret_cast<const uint8_t*>(img.data()), img.size());
  if (!text) return 1;
  bool failed = std::strncmp(text, "error: ", 7) == 0;
  if (failed) std::fprintf(stderr, "tdis: %s", text);
  else if (!tend::cli::write_file(out, text, std::strlen(text))) failed = true;
  tend_free(text);
  return failed ? 1 : 0;
}
