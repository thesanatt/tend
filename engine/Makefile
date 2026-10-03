# Tend law engine.
#   make              release build: libtend.a, libtend.{dylib,so}, tendc, tdis, tendvm
#   make test         unit, semantic, differential, and corpus tests
#   make test-san     the same tests under AddressSanitizer + UBSan
#   make fuzz FUZZ_SECONDS=300
#   make bench        1M-item benchmark
#   make laws         compile every jurisdiction in IR (rules/ir + rules/verified) to build/laws
#   make wasm         Emscripten build into ../web/public/engine/
#   make wasm-parity  WASM vs native, byte for byte, on the difftest claims

BUILD ?= build
OPT ?= -O2
SANFLAGS ?=
IR ?= ../rules/ir
VERIFIED ?= ../rules/verified

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  SHLIB := $(BUILD)/libtend.dylib
  SHLIB_FLAGS := -dynamiclib -install_name @rpath/libtend.dylib
else
  SHLIB := $(BUILD)/libtend.so
  SHLIB_FLAGS := -shared -Wl,-soname,libtend.so
endif

CXXFLAGS_BASE := -std=c++20 -Wall -Wextra -Wpedantic -Wshadow -Iinclude -Isrc -Ithird_party
CXXFLAGS := $(CXXFLAGS_BASE) $(OPT) -DNDEBUG -fPIC -fvisibility=hidden $(SANFLAGS)
LDFLAGS := $(SANFLAGS)

RUNTIME_SRCS := src/format.cpp src/sha256.cpp src/civil.cpp src/json.cpp src/image.cpp src/builder.cpp \
                src/vm.cpp src/eval.cpp src/disasm.cpp src/capi.cpp
COMPILER_SRCS := src/compiler.cpp
TEST_SRCS := $(wildcard tests/*.cpp)

OBJ := $(BUILD)/obj
RUNTIME_OBJS := $(RUNTIME_SRCS:%.cpp=$(OBJ)/%.o)
COMPILER_OBJS := $(COMPILER_SRCS:%.cpp=$(OBJ)/%.o)
TEST_OBJS := $(TEST_SRCS:%.cpp=$(OBJ)/%.o)

FIXTURE_IR := tests/fixtures/ir/ZZ.json
FIXTURE_CLAIM := tests/fixtures/ZZ_claim.json

.PHONY: all test test-san fuzz bench laws wasm wasm-parity clean

all: $(BUILD)/libtend.a $(SHLIB) $(BUILD)/tendc $(BUILD)/tdis $(BUILD)/tendvm

$(OBJ)/%.o: %.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -MMD -MP -c $< -o $@

$(BUILD)/libtend.a: $(RUNTIME_OBJS)
	@rm -f $@
	ar rcs $@ $^

$(BUILD)/libtendc.a: $(COMPILER_OBJS)
	@rm -f $@
	ar rcs $@ $^

$(SHLIB): $(RUNTIME_OBJS)
	$(CXX) $(SHLIB_FLAGS) $(LDFLAGS) $^ -o $@

$(BUILD)/tendc: $(OBJ)/tools/tendc.o $(BUILD)/libtendc.a $(BUILD)/libtend.a
	$(CXX) $(LDFLAGS) $^ -o $@

$(BUILD)/tdis: $(OBJ)/tools/tdis.o $(BUILD)/libtend.a
	$(CXX) $(LDFLAGS) $^ -o $@

$(BUILD)/tendvm: $(OBJ)/tools/tendvm.o $(BUILD)/libtend.a
	$(CXX) $(LDFLAGS) $^ -o $@

$(BUILD)/tend_tests: $(TEST_OBJS) $(BUILD)/libtendc.a $(BUILD)/libtend.a
	$(CXX) $(LDFLAGS) $^ -o $@

# The law images the browser ships (web/public/engine/laws) must be what tendc
# builds from the default corpus now; pointing IR or VERIFIED elsewhere skips
# that check.
SHIPPED ?= $(if $(and $(filter ../rules/ir,$(IR)),$(filter ../rules/verified,$(VERIFIED))),../web/public/engine)

test: $(BUILD)/tend_tests $(BUILD)/tendc $(BUILD)/tendvm $(BUILD)/tdis
	TEND_IR_DIR=$(IR) TEND_RULES_DIR=$(VERIFIED) TEND_SHIPPED_DIR=$(SHIPPED) TEND_BUILD_DIR=$(BUILD) ./$(BUILD)/tend_tests

test-san:
	$(MAKE) BUILD=build/san OPT="-O1 -g -fno-omit-frame-pointer" \
	  SANFLAGS="-fsanitize=address,undefined -fno-sanitize-recover=all" test

# Coverage-guided mutation fuzzer (Apple clang ships no libFuzzer runtime, so
# fuzz/fuzz.cpp drives SanitizerCoverage callbacks itself).
FUZZ_SECONDS ?= 120
FUZZ_DIR := build/fuzz
FUZZ_FLAGS := -std=c++20 -O1 -g -fno-omit-frame-pointer -Iinclude -Isrc -Ithird_party \
              -fsanitize=address,undefined -fno-sanitize-recover=all
FUZZ_LIB_OBJS := $(RUNTIME_SRCS:%.cpp=$(FUZZ_DIR)/obj/%.o) $(COMPILER_SRCS:%.cpp=$(FUZZ_DIR)/obj/%.o)
FUZZ_SEED_DIR := $(if $(wildcard $(IR)/*.json),--seed-json-dir $(IR))
# A second claim with typed units, tags, and a total cap to cross.
FUZZ_EXTRA_INPUT := $(if $(wildcard ../refengine/tests/golden/zz_mixed.input.json),--seed-input ../refengine/tests/golden/zz_mixed.input.json)

$(FUZZ_DIR)/obj/%.o: %.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(FUZZ_FLAGS) -fsanitize-coverage=trace-pc-guard -c $< -o $@

$(FUZZ_DIR)/tend_fuzz: fuzz/fuzz.cpp $(FUZZ_LIB_OBJS)
	@mkdir -p $(FUZZ_DIR)
	$(CXX) $(FUZZ_FLAGS) fuzz/fuzz.cpp $(FUZZ_LIB_OBJS) -o $@

fuzz: $(FUZZ_DIR)/tend_fuzz
	./$(FUZZ_DIR)/tend_fuzz --seconds $(FUZZ_SECONDS) --corpus $(FUZZ_DIR)/corpus \
	  --seed-json $(FIXTURE_IR) --seed-input $(FIXTURE_CLAIM) $(FUZZ_EXTRA_INPUT) $(FUZZ_SEED_DIR)

bench: $(BUILD)/tendc $(BUILD)/tendvm
	@mkdir -p $(BUILD)/laws
	./$(BUILD)/tendc --quiet $(FIXTURE_IR) -o $(BUILD)/laws/ZZ.tlaw
	./$(BUILD)/tendvm bench --law $(BUILD)/laws/ZZ.tlaw --items 1000000 --runs 5

laws: $(BUILD)/tendc
	./scripts/build_laws.sh $(IR) $(VERIFIED) $(BUILD)/laws

wasm:
	./scripts/build_wasm.sh "$(CURDIR)/../web/public/engine" "$(abspath $(IR))" "$(abspath $(VERIFIED))"

# The WASM build against the native engine on the difftest's claims (2,000 per
# jurisdiction by default), byte for byte, using the shipped law images.
PARITY_N ?= 2000
PYTHON ?= uv run --project ../refengine --python 3.12 python
wasm-parity: all
	rm -rf build/wasm-corpus
	$(PYTHON) ../refengine/difftest.py --n $(PARITY_N) --ir-dir $(IR) --verified-dir $(VERIFIED) --corpus build/wasm-corpus
	node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests/wasm_parity.mjs build/wasm-corpus ../web/public/engine

clean:
	rm -rf build

-include $(RUNTIME_OBJS:.o=.d) $(COMPILER_OBJS:.o=.d) $(TEST_OBJS:.o=.d) $(OBJ)/tools/tendc.d \
         $(OBJ)/tools/tdis.d $(OBJ)/tools/tendvm.d
