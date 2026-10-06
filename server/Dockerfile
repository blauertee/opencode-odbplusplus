# OdbDesignServer built from source against Ubuntu's protobuf/gRPC packages.
#
# Upstream publishes images only to ghcr.io and builds dependencies through
# vcpkg; this image avoids both and applies the patches in ./patches:
#   0001  accept ODB++ records without attribute section / empty attribute
#         strings (KiCad 9 exports fail to parse otherwise)
#   0002  build with distro protobuf 3.21 / gRPC 1.51 instead of vcpkg
FROM ubuntu:24.04 AS build

ARG ODBDESIGN_REF=d777042fa42a206ce0216ea016064d98640ed57f
ARG CROW_REF=v1.2.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git cmake ninja-build g++ pkg-config \
      libprotobuf-dev protobuf-compiler libgrpc++-dev protobuf-compiler-grpc \
      libarchive-dev zlib1g-dev libasio-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch ${CROW_REF} https://github.com/CrowCpp/Crow \
    && cmake -S Crow -B Crow/build -G Ninja -DCROW_BUILD_EXAMPLES=OFF -DCROW_BUILD_TESTS=OFF \
    && cmake --install Crow/build

RUN git clone https://github.com/nam20485/OdbDesign odbdesign \
    && git -C odbdesign checkout ${ODBDESIGN_REF}
COPY patches/ /src/patches/
RUN cd odbdesign && for p in /src/patches/*.patch; do git apply "$p"; done \
    && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j"$(nproc)"

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl libprotobuf32t64 libgrpc++1.51t64 libarchive13t64 zlib1g \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/odbdesign/build/OdbDesignServer/OdbDesignServer /opt/odbdesign/
COPY --from=build /src/odbdesign/build/OdbDesignServer/config.json /opt/odbdesign/
COPY --from=build /src/odbdesign/build/OdbDesignLib/libOdbDesign.so /src/odbdesign/build/Utils/libUtils.so /usr/local/lib/
RUN ldconfig && mkdir -p /srv/designs
# Absolute paths in arguments are parsed as (Windows-style) flags by the
# server, so the designs directory is given relative to the working dir.
WORKDIR /srv
EXPOSE 8888
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fs http://localhost:8888/healthz/live || exit 1
ENTRYPOINT ["/opt/odbdesign/OdbDesignServer", "--designs-dir", "designs"]
CMD ["--disable-authentication"]
