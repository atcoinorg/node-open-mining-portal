FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ libgmp-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PYTHON=/usr/bin/python3

# The upstream lockfile uses SSH URLs for public GitHub dependencies.
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts \
    && sed -i -e 's/-std=c++11/-std=c++17/g' -e 's/-std=c++14/-std=c++17/g' node_modules/multi-hashing/binding.gyp \
    && CFLAGS="-fno-strict-aliasing" CXXFLAGS="-fno-strict-aliasing" npm_config_nodedir=/usr/local npm rebuild --build-from-source \
    && npm cache clean --force

COPY . .
RUN node .docker/npm/patch-dependencies.js && node .docker/npm/check-native.js \
    && chown -R node:node /app
USER node
CMD ["node", "init.js"]
