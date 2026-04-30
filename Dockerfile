FROM python:3.11

# Install Node.js and required build tools.
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm \
  && rm -rf /var/lib/apt/lists/*

# Copy uv from the official image.
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /bin/

WORKDIR /app

# Copy dependency manifests first for layer caching.
COPY package.json package-lock.json ./
COPY backend/pyproject.toml backend/uv.lock ./backend/

# Install the unified app and backend dependencies.
RUN npm ci \
  && cd backend && uv sync --frozen

# Copy project sources.
COPY . .

EXPOSE 3000 5001 5002 5004

# Boot the full integrated stack.
CMD ["npm", "run", "dev:full"]
