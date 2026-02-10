# Hello World MCP Server

A simple HTTP-stream MCP server built with FastMCP.

## Installation & Running with uv

### Quick Start (Recommended)

Simply run with `uv run` - it will automatically handle dependencies:

```bash
uv run server.py
```

### Alternative: Using uv sync

For a more structured setup:

```bash
# Install dependencies and create virtual environment
uv sync

# Run the server
uv run python server.py
```

### Traditional pip/venv (Alternative)

```bash
# Activate virtual environment
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the server
python server.py
```

The server will start on `http://0.0.0.0:8000/mcp` with HTTP-streaming support.

## Tools

- `hello_world`: A simple greeting tool that takes an optional name parameter.
