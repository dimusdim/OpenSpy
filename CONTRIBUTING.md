# Contributing to OpenSpy

Thanks for your interest in contributing! Here's how to get started.

## Getting Started

1. Fork the repo
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/OpenSpy.git`
3. Create a branch: `git checkout -b feature/your-feature`
4. Make your changes
5. Push and open a PR

## Development Setup

```bash
# Backend
cd backend
npm install
cp .env.example .env
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

## What to Contribute

- New data layers and sources
- Performance optimizations
- UI/UX improvements
- Bug fixes
- Documentation
- Tests

## Guidelines

- Keep PRs focused on a single change
- Add comments for non-obvious logic
- Test your changes locally before submitting
- Follow existing code patterns and naming conventions

## Adding a New Data Layer

1. Create a backend service in `backend/src/services/`
2. Add the API route in `backend/src/index.ts`
3. Create a frontend layer hook in `frontend/src/cesium/`
4. Register the layer in `useTimelineStore.ts`
5. Add to LayerManager and Legend components

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
