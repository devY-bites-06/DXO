# DXO — AI-Powered Assignment Helper

DXO is an advanced, automated AI-powered assignment helper designed to assist with learning, solving coding assignments, and evaluating answers using a state-of-the-art Corrective RAG (CRAG) pipeline powered by Gemini and PostgreSQL.

> [!WARNING]
> **Use Responsibly:**
> This tool is intended strictly as an educational resource, study aid, and practice assistant. It is designed to help you understand challenging concepts, system design architectures, and complex programming patterns. Please check your institution's academic integrity guidelines and use this helper responsibly to enhance your personal learning, not to bypass it.

---

## Getting Started

### 1. Clone the Repository
Clone the codebase to your local system using:
```bash
git clone https://github.com/devY-bites-06/DXO.git
cd DXO
```

### 2. Install Dependencies
Install all package dependencies:
```bash
npm install
```

---

## Configuration Setup

Before running tests or launching the application, you must set up your environment variables.

1. Copy the example environment file to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and fill in your details:
   - `GEMINI_API_KEY`: Your Gemini API key.
   - `POSTGRES_PASSWORD`: Your local PostgreSQL password.
   - Adjust `POSTGRES_PORT` or other settings if your local database runs on a non-default configuration.

*Note: Your study notes/knowledge documents should be placed inside the `knowledge/` directory (e.g., `knowledge/notes.txt`). This folder is ignored by git.*

---

## Using Test Files

DXO comes equipped with a comprehensive integration test suite to verify the Corrective Retrieval-Augmented Generation (CRAG) pipeline, indexing, and pgvector-backed PostgreSQL integration.

### Run the Integration Test
```bash
node tests/test-crag.js
```

### What the test verifies:
- **Database Bootstrapping**: Verifies the connection and creates the `crag_knowledge` schema.
- **pgvector Integration**: Verifies the availability of the `pgvector` extension.
- **Ingestion & Indexing**: Chunks your study materials in the `knowledge/` folder, computes Gemini embeddings, and indexes them in PostgreSQL.
- **Hybrid Search & CRAG**: Performs advanced hybrid search and runs the full RAG pipeline to generate high-confidence responses.

*For more details on the test environment, see the [tests/testmethod.md](tests/testmethod.md) documentation.*

---

## Core Commands

### Development Server
Run the local electron application in development mode with hot-reloading:
```bash
npm run dev
```

### Compile Codebase
Manually compile the TypeScript source files:
```bash
npx tsc -p tsconfig.electron.json
```

### Build Production Artifacts
Compile and build optimized client and main-process code:
```bash
npm run build
```

### Clean Builds
Remove generated build directories (`dist` and `dist-electron`):
```bash
npm run clean
```
