cmake_minimum_required(VERSION 3.20)
project(tend VERSION 1.2.0 LANGUAGES CXX)

# Native:     cmake -S engine -B engine/build/cmake -G Ninja && cmake --build engine/build/cmake && ctest --test-dir engine/build/cmake
# WebAssembly: emcmake cmake -S engine -B engine/build/wasm-cmake -G Ninja && cmake --build engine/build/wasm-cmake

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(TEND_RUNTIME_SOURCES
  src/format.cpp src/sha256.cpp src/civil.cpp src/json.cpp src/image.cpp src/builder.cpp
  src/vm.cpp src/eval.cpp src/disasm.cpp src/capi.cpp)

add_library(tend_headers INTERFACE)
target_include_directories(tend_headers INTERFACE
  ${CMAKE_CURRENT_SOURCE_DIR}/include ${CMAKE_CURRENT_SOURCE_DIR}/src ${CMAKE_CURRENT_SOURCE_DIR}/third_party)

add_library(tend_objects OBJECT ${TEND_RUNTIME_SOURCES})
target_link_libraries(tend_objects PUBLIC tend_headers)
set_target_properties(tend_objects PROPERTIES POSITION_INDEPENDENT_CODE ON CXX_VISIBILITY_PRESET hidden)
if(NOT MSVC)
  target_compile_options(tend_objects PRIVATE -Wall -Wextra -Wpedantic -Wshadow)
endif()

if(EMSCRIPTEN)
  target_compile_options(tend_objects PRIVATE -fno-exceptions)
  add_executable(tend_wasm $<TARGET_OBJECTS:tend_objects>)
  set_target_properties(tend_wasm PROPERTIES OUTPUT_NAME tend SUFFIX ".js")
  target_link_options(tend_wasm PRIVATE
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createTendModule
    -sENVIRONMENT=web,worker,node -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1
    "-sEXPORTED_FUNCTIONS=_tend_eval_json,_tend_disasm,_tend_inspect_json,_tend_version,_tend_free,_malloc,_free"
    "-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToNewUTF8,HEAPU8")
  return()
endif()

add_library(tend STATIC $<TARGET_OBJECTS:tend_objects>)
target_link_libraries(tend PUBLIC tend_headers)

add_library(tend_shared SHARED $<TARGET_OBJECTS:tend_objects>)
target_link_libraries(tend_shared PUBLIC tend_headers)
set_target_properties(tend_shared PROPERTIES OUTPUT_NAME tend)

add_library(tendc_lib STATIC src/compiler.cpp)
target_link_libraries(tendc_lib PUBLIC tend)

add_executable(tendc tools/tendc.cpp)
target_link_libraries(tendc PRIVATE tendc_lib)
add_executable(tdis tools/tdis.cpp)
target_link_libraries(tdis PRIVATE tend)
add_executable(tendvm tools/tendvm.cpp)
target_link_libraries(tendvm PRIVATE tend)

enable_testing()
find_package(Threads REQUIRED)
file(GLOB TEND_TEST_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tests/*.cpp)
add_executable(tend_tests ${TEND_TEST_SOURCES})
target_link_libraries(tend_tests PRIVATE tendc_lib Threads::Threads)
add_test(NAME tend_tests COMMAND tend_tests WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
set_tests_properties(tend_tests PROPERTIES ENVIRONMENT
  "TEND_IR_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../rules/ir;TEND_RULES_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../rules/verified;TEND_SHIPPED_DIR=${CMAKE_CURRENT_SOURCE_DIR}/../web/public/engine;TEND_BUILD_DIR=${CMAKE_CURRENT_BINARY_DIR}")
