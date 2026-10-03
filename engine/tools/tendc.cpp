// tendc: compile one jurisdiction's law IR into a .tlaw law image.
#include <cstdio>
#include <cstring>
#include <string>

#include "cli_util.h"
#include "compiler.h"
#include "image.h"
#include "sha256.h"

static int usage() {
  std::fprintf(stderr,
               "usage: tendc rules/ir/ST.json -o ST.tlaw [--verified rules/verified/ST.json | --no-verified] [--quiet]\n"
               "The verified file defaults to ../verified/ST.json next to the IR; its sha256 must match\n"
               "the IR's source_sha256.\n");
  return 2;
}

int main(int argc, char** argv) {
  std::string in, out, verified;
  bool quiet = false, no_verified = false;
  for (int i = 1; i < argc; i++) {
    if (!std::strcmp(argv[i], "-o") && i + 1 < argc) out = argv[++i];
    else if (!std::strcmp(argv[i], "--verified") && i + 1 < argc) verified = argv[++i];
    else if (!std::strcmp(argv[i], "--no-verified")) no_verified = true;
    else if (!std::strcmp(argv[i], "--quiet") || !std::strcmp(argv[i], "-q")) quiet = true;
    else if (argv[i][0] == '-' && argv[i][1]) return usage();
    else if (in.empty()) in = argv[i];
    else return usage();
  }
  if (in.empty() || out.empty()) return usage();

  std::string ir_bytes, verified_bytes;
  if (!tend::cli::read_file(in, ir_bytes)) {
    std::fprintf(stderr, "tendc: cannot read %s\n", in.c_str());
    return 1;
  }
  if (!no_verified) {
    if (verified.empty()) {
      size_t slash = in.find_last_of('/');
      std::string dir = slash == std::string::npos ? "." : in.substr(0, slash);
      std::string base = slash == std::string::npos ? in : in.substr(slash + 1);
      verified = dir + "/../verified/" + base;
    }
    if (!tend::cli::read_file(verified, verified_bytes) || verified_bytes.empty()) {
      std::fprintf(stderr, "tendc: cannot read the verified file %s (pass --verified or --no-verified)\n", verified.c_str());
      return 1;
    }
  }
  tend::CompileResult res;
  std::string err;
  if (!tend::compile_law(ir_bytes, verified_bytes, res, err)) {
    std::fprintf(stderr, "tendc: %s: %s\n", in.c_str(), err.c_str());
    return 1;
  }
  // Never write an image the loader would reject.
  tend::Law law;
  if (!tend::load_law(res.image.data(), res.image.size(), law, err)) {
    std::fprintf(stderr, "tendc: internal error, image failed verification: %s\n", err.c_str());
    return 1;
  }
  if (!tend::cli::write_file(out, res.image.data(), res.image.size())) {
    std::fprintf(stderr, "tendc: cannot write %s\n", out.c_str());
    return 1;
  }
  if (!quiet) {
    for (const auto& n : res.notes) std::fprintf(stderr, "tendc: note: %s\n", n.c_str());
    std::fprintf(stderr, "tendc: %s %zu rules -> %s (%zu bytes, sha256 %s)\n", law.jurisdiction, law.rules.size(),
                 out.c_str(), res.image.size(), tend::to_hex(law.image_sha256, 32).c_str());
  }
  return 0;
}
