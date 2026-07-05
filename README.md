# CodeCrab Router

Native LLM Router for CodeCrab based on `node-llama-cpp`.

## Local Configuration

The router uses a machine-specific configuration file that is deliberately excluded from version control to protect your local paths and settings.

### Setup Instructions

1. **Copy the example configuration:**
   ```bash
   cp src/config/config.example.ts src/config/config.local.ts
   ```

2. **Update your local paths:**
   Open `src/config/config.local.ts` and set the absolute paths to your `.gguf` model files, your default workspace, and your runtime/cache directories.

   ```typescript
   export default {
       models: {
           advisor:   '/absolute/path/to/qwen-advisor.gguf',
           backend:   '/absolute/path/to/qwen-backend.gguf',
           frontend:  '/absolute/path/to/qwen-frontend.gguf',
           embedding: '/absolute/path/to/embedding.gguf',
       },
       // ...
   };
   ```

3. **Run the server:**
   ```bash
   npx tsx src/index.ts
   ```

> **Note:** The server will refuse to boot if `config.local.ts` is missing, or if any of the configured models do not physically exist on your disk.

## Model Resolution

You do not need to configure *every* model path. If a specific model is missing from `config.local.ts`, the router will fall back to automatic discovery, searching for matching `.gguf` files in `models/base/` and `models/adapters/`.
LLM links
google drive->
https://drive.google.com/drive/u/1/folders/1vCbjjR-Jc6pch_4q-u4OlQFeuGQ-zUfC
