# Contributing to Interview Copilot

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a feature branch
4. Make your changes
5. Submit a pull request

## Development Setup

### Prerequisites

- macOS 13+
- Node.js 18+
- Git

### Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/interview-copilot.git
cd interview-copilot

# Install dependencies
npm install

# Start development mode
npm run dev

# In another terminal, start the app
npm start
```

## Code Style

### TypeScript

- Use strict mode
- Prefer interfaces over types
- Use explicit return types for public functions
- Avoid `any` - use `unknown` and type guards
- Use async/await over callbacks

### React

- Use functional components with hooks
- Keep components small and focused
- Use TypeScript interfaces for props
- Avoid inline styles

### Git

- Use conventional commits
- Write clear commit messages
- Keep commits focused and atomic

## Pull Request Process

1. Update documentation if needed
2. Add tests for new features
3. Ensure all tests pass
4. Request review from maintainers

## Reporting Issues

Use the issue tracker to report bugs or suggest features.

### Bug Reports

Include:
- Steps to reproduce
- Expected behavior
- Actual behavior
- macOS version
- Node.js version

### Feature Requests

Include:
- Problem description
- Proposed solution
- Alternatives considered

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
