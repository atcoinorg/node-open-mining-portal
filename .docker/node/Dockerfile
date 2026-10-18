FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    software-properties-common \
    gnupg \
    ca-certificates \
    wget && \
    apt-key adv --keyserver keyserver.ubuntu.com --recv-keys 60C317803A41BA51845E371A1E9377A2BA9EF27F && \
    echo "deb http://ppa.launchpad.net/ubuntu-toolchain-r/test/ubuntu jammy main" > /etc/apt/sources.list.d/ubuntu-toolchain-r.list

# Installing dependencies
RUN apt-get update && \
    apt-get install -y wget && \
    apt-get install -y build-essential && \
    apt-get install -y autoconf && \
    apt-get install -y libtool && \
    apt-get install -y pkg-config && \
    apt-get install -y libevent-dev && \
    apt-get install -y bsdmainutils && \
    apt-get install -y python3 && \
    apt-get install -y git && \
    apt-get install -y cmake && \
    apt-get install -y libboost-all-dev && \
    apt-get install -y libsqlite3-dev && \
    apt-get install -y libdb-dev && \
    apt-get install -y libdb++-dev && \
    apt-get install -y libminiupnpc-dev && \
    apt-get install -y libzmq3-dev && \
    apt-get install -y libevent-dev && \
    apt-get install -y iputils-ping && \
    apt-get install -y libstdc++6 && \
    apt-get install -y libfaketime && \
    apt-get install -y faketime && \
    rm -rf /var/lib/apt/lists/*


# Copying your source files
WORKDIR /src/atcoin
RUN wget -c https://github.com/atcoinorg/atcoin/releases/download/v0.4/atcoin_0.4_amd64-console-shared.deb -O atcoin_0.4_amd64-console-shared.deb
RUN apt-get update && apt-get install -y ./atcoin_0.4_amd64-console-shared.deb

# Opening ports
EXPOSE 18333 19332

CMD ["atcoind", "-printtoconsole"]