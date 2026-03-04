# Minecraft AI on Linux

AI-powered Minecraft pipeline connecting DGX Spark compute to Linux desktop gameplay.

## Architecture

```
Mac Mini (dev/orchestration)
    |
    v
GitHub (husky2466-codo/minecraft-ai-on-linux)
    |               |
    v               v
My DGX          Linux Desktop
(AI compute)    (Minecraft host)
```

## Machines

| Machine | Role | IP |
|---------|------|----|
| Mac Mini M4 | Development / orchestration | 10.0.0.223 |
| My DGX Spark | AI compute (model training/inference) | 10.0.0.69 |
| Linux Desktop | Minecraft Java Edition host | 10.0.0.10 |

## Structure

```
minecraft-ai-on-linux/
├── ai/              # AI models, training scripts, inference code (DGX)
├── minecraft/       # Minecraft configs, mods, scripts (Linux Desktop)
├── pipeline/        # Orchestration scripts connecting AI to game
├── .github/
│   └── workflows/   # GitHub Actions for cross-machine sync
└── README.md
```

## Repo Locations

- Mac Mini: `/Volumes/DevDrive/Projects/Minecraft-AI-on-Linux`
- Linux Desktop: `~/Projects/minecraft-ai-on-linux`
- My DGX: `~/Projects/minecraft-ai-on-linux`
