# Replicate Image MCP Server

Custom MCP server for image generation and editing using the Replicate API.

## Features

- **generate_image**: Generate new images from text prompts.
- **edit_image**: Transform existing images using text prompts.

## Implementation Details

- Uses `openai/gpt-image-1.5` by default.
- Built with Python and `FastMCP`.
- Managed with `uv`.

## Requirements

- `REPLICATE_API_TOKEN` environment variable.

