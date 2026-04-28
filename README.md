# NextScrapperV2 - Run Everything From One Command

## Prerequisites

- Node.js and npm installed
- Docker Desktop installed and running

## First-Time Setup

Run this once from the project root:

### CMD

```cmd
npm install
```

### PowerShell

```powershell
npm install
```

## Start Full Project (Docker + API + Client)

This starts:
- Postgres + Redis via Docker
- Backend API (`src/server.ts`)
- Next.js client (`client`)

### CMD

```cmd
powershell -ExecutionPolicy Bypass -File .\start-all.ps1
```

### PowerShell

```powershell
.\start-all.ps1
```

If script execution is blocked:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-all.ps1
```

## Stop Everything

1. In the running terminal, press `Ctrl + C` to stop API + client.
2. Stop Docker services:

### CMD

```cmd
docker compose down
```

### PowerShell

```powershell
docker compose down
```

## Optional: Start Without Script

You can also run all services directly with npm:

### CMD / PowerShell

```cmd
npm run dev:all
```
