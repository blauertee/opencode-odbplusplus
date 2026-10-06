# Builds libodbpp: OdbDesign's library plus a small C ABI for bun:ffi.
# OdbDesign is pulled in as a subproject (see build.sh), library only.
cmake_minimum_required(VERSION 3.21)
project(odbpp CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(ODBDESIGN_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vendor/OdbDesign" CACHE PATH "OdbDesign checkout")
set(ODBDESIGN_LIB_ONLY ON CACHE BOOL "" FORCE)
add_subdirectory(${ODBDESIGN_SOURCE_DIR} odbdesign EXCLUDE_FROM_ALL)

add_library(odbpp SHARED odbpp.cpp)
target_link_libraries(odbpp PRIVATE OdbDesign Utils)
target_include_directories(odbpp PRIVATE ${ODBDESIGN_SOURCE_DIR}/OdbDesignLib ${ODBDESIGN_SOURCE_DIR}/Utils)

# Ship libodbpp next to libOdbDesign/libUtils and find them via $ORIGIN.
set_target_properties(odbpp PROPERTIES BUILD_RPATH "$ORIGIN" INSTALL_RPATH "$ORIGIN")
set_target_properties(OdbDesign Utils PROPERTIES BUILD_RPATH "$ORIGIN" INSTALL_RPATH "$ORIGIN")
install(TARGETS odbpp OdbDesign Utils LIBRARY DESTINATION .)
