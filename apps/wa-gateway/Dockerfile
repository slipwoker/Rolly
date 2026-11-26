# rolly-wa-gateway: build context is apps/wa-gateway. Run exactly ONE instance (a linked device cannot connect twice).
FROM golang:1.26-bookworm AS build
ENV GOTOOLCHAIN=auto
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# cgo is on because the local-development SQLite driver is compiled in; production uses Postgres
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/wa-gateway .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --shell /usr/sbin/nologin gateway
COPY --from=build /out/wa-gateway /usr/local/bin/wa-gateway
USER gateway
ENV WA_ADDR=:10000
EXPOSE 10000
CMD ["wa-gateway"]
