variable "CACHE_WRITE" {
  default = false
}

group "ci" {
  targets = ["api-release", "worker", "runtime", "web"]
}

target "_backend" {
  context    = "."
  dockerfile = "deploy/railway/Dockerfile.backend"
}

target "api-release" {
  inherits = ["_backend"]
  args = {
    RAILWAY_SERVICE_NAME = "release"
  }
  tags = ["companion-api:ci", "companion-release:ci"]
  cache-from = [
    "type=gha,scope=railway-release",
    "type=gha,scope=railway-api",
  ]
  cache-to = CACHE_WRITE ? ["type=gha,mode=max,scope=railway-release"] : []
}

target "worker" {
  inherits = ["_backend"]
  args = {
    RAILWAY_SERVICE_NAME = "worker"
  }
  tags       = ["companion-worker:ci"]
  cache-from = ["type=gha,scope=railway-worker"]
  cache-to   = CACHE_WRITE ? ["type=gha,mode=max,scope=railway-worker"] : []
}

target "runtime" {
  inherits = ["_backend"]
  args = {
    RAILWAY_SERVICE_NAME = "runtime"
  }
  tags       = ["companion-runtime:ci"]
  cache-from = ["type=gha,scope=railway-runtime"]
  cache-to   = CACHE_WRITE ? ["type=gha,mode=max,scope=railway-runtime"] : []
}

target "web" {
  context    = "."
  dockerfile = "deploy/railway/Dockerfile.web"
  args = {
    COMPANION_API_URL              = "http://127.0.0.1:18082"
    COMPANION_WEB_URL              = "http://127.0.0.1:18080"
    NEXT_PUBLIC_COMPANION_API_BASE = "http://127.0.0.1:18080/v1"
  }
  tags       = ["companion-web:ci"]
  cache-from = ["type=gha,scope=railway-web"]
  cache-to   = CACHE_WRITE ? ["type=gha,mode=max,scope=railway-web"] : []
}
