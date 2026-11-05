cmake_minimum_required(VERSION 3.21)
project(vega_torrentd CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# One self-contained exe: static CRT, static libtorrent/boost/openssl (vcpkg x64-windows-static).
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

find_package(LibtorrentRasterbar CONFIG REQUIRED)
find_package(httplib CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

add_executable(vega-torrentd main.cpp)
target_link_libraries(vega-torrentd PRIVATE
  LibtorrentRasterbar::torrent-rasterbar
  httplib::httplib
  nlohmann_json::nlohmann_json)
if(WIN32)
  target_compile_definitions(vega-torrentd PRIVATE _WIN32_WINNT=0x0A00)
  target_compile_options(vega-torrentd PRIVATE /utf-8 /bigobj)
endif()
