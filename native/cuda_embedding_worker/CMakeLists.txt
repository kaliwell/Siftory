cmake_minimum_required(VERSION 3.24)
project(floating_clock_cuda_embedding_worker LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "The CUDA embedding worker currently targets Windows x64")
endif()
if(NOT DEFINED ORT_ROOT)
  message(FATAL_ERROR "ORT_ROOT must point to an ONNX Runtime 1.24.3 NuGet extraction")
endif()
if(NOT DEFINED CUDA_WORKER_OUTPUT_DIR)
  set(CUDA_WORKER_OUTPUT_DIR "${CMAKE_BINARY_DIR}/out")
endif()

if(NOT ORT_INCLUDE_DIR)
  set(ORT_INCLUDE_DIR "${ORT_ROOT}/build/native/include")
endif()
set(ORT_LIBRARY "${ORT_ROOT}/runtimes/win-x64/native/onnxruntime.lib")
if(NOT EXISTS "${ORT_INCLUDE_DIR}/onnxruntime_cxx_api.h")
  message(FATAL_ERROR "ORT_ROOT does not contain onnxruntime_cxx_api.h")
endif()
if(NOT EXISTS "${ORT_LIBRARY}")
  message(FATAL_ERROR "ORT_ROOT does not contain the Windows x64 import library")
endif()

add_executable(floating_clock_cuda_embedding_worker cuda_embedding_worker.cc)
target_compile_features(floating_clock_cuda_embedding_worker PRIVATE cxx_std_20)
target_compile_definitions(floating_clock_cuda_embedding_worker PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_include_directories(floating_clock_cuda_embedding_worker PRIVATE "${ORT_INCLUDE_DIR}")
target_link_libraries(floating_clock_cuda_embedding_worker PRIVATE "${ORT_LIBRARY}")
target_compile_options(floating_clock_cuda_embedding_worker PRIVATE /W4 /WX /permissive- /utf-8)
set_target_properties(
  floating_clock_cuda_embedding_worker
  PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CUDA_WORKER_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CUDA_WORKER_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CUDA_WORKER_OUTPUT_DIR}"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CUDA_WORKER_OUTPUT_DIR}"
)
