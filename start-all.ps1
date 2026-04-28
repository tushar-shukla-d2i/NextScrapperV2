$ErrorActionPreference = "Stop"

Write-Host "Starting Docker services (Postgres + Redis)..." -ForegroundColor Cyan
docker compose up -d

Write-Host "Starting API + Next.js client..." -ForegroundColor Green
npm run dev:all
