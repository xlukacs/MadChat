#!/usr/bin/env python3
"""
Simple HTTP-stream MCP server using FastMCP
"""

from fastmcp import FastMCP

# Create the MCP server
mcp = FastMCP("HelloWorldServer")


@mcp.tool
def hello_world(name: str = "World") -> str:
    """
    A simple hello world tool that greets the user.
    
    Args:
        name: The name to greet (default: "World")
    
    Returns:
        A greeting message
    """
    return f"Hello, {name}! Welcome to the FastMCP HTTP-stream server."


if __name__ == "__main__":
    # Run the server with HTTP-streaming support
    mcp.run(transport="http", host="0.0.0.0", port=8000, path="/mcp")
