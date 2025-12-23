import os
import replicate
import logging
from typing import List, Optional
from mcp.server.fastmcp import FastMCP
from pydantic import Field

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("replicate-image-mcp")

# Initialize FastMCP server
mcp = FastMCP("Replicate Image Server")

# Model identifier for gpt-image-1.5
# Note: Ensure this matches the exact identifier on Replicate
DEFAULT_MODEL = "openai/gpt-image-1.5"

@mcp.tool()
async def generate_image(
    prompt: str, 
    aspect_ratio: str = "1:1", 
    num_outputs: int = 1,
    model: str = DEFAULT_MODEL
) -> List[str]:
    """
    Generate images from a text prompt using a Replicate model.
    
    Args:
        prompt: Text description of the image to generate.
        aspect_ratio: Aspect ratio of the generated image (e.g., "1:1", "16:9", "4:3").
        num_outputs: Number of images to generate (1-4).
        model: Replicate model identifier (defaults to openai/gpt-image-1.5).
    """
    logger.info(f"Generating image with model {model} and prompt: {prompt}")
    
    try:
        # replicate.run is synchronous by default in the library, 
        # but FastMCP handles sync/async tools correctly.
        output = replicate.run(
            model,
            input={
                "prompt": prompt,
                "aspect_ratio": aspect_ratio,
                "num_outputs": num_outputs,
                "quality": "low"
            }
        )
        
        # Output is typically a list of URLs (strings)
        if isinstance(output, list):
            return [str(url) for url in output]
        return [str(output)]
        
    except Exception as e:
        logger.error(f"Error in generate_image: {str(e)}")
        raise RuntimeError(f"Failed to generate image: {str(e)}")

@mcp.tool()
async def edit_image(
    image_url: str, 
    prompt: str, 
    aspect_ratio: str = "1:1", 
    num_outputs: int = 1,
    model: str = DEFAULT_MODEL
) -> List[str]:
    """
    Edit or transform an existing image using a text prompt.
    
    Args:
        image_url: URL of the image to edit.
        prompt: Instructions for how to edit or transform the image.
        aspect_ratio: Aspect ratio of the result.
        num_outputs: Number of variations to generate.
        model: Replicate model identifier (defaults to openai/gpt-image-1.5).
    """
    logger.info(f"Editing image {image_url} with model {model} and prompt: {prompt}")
    
    try:
        output = replicate.run(
            model,
            input={
                "image": image_url,
                "prompt": prompt,
                "aspect_ratio": aspect_ratio,
                "num_outputs": num_outputs,
                "quality": "low"
            }
        )
        
        if isinstance(output, list):
            return [str(url) for url in output]
        return [str(output)]
        
    except Exception as e:
        logger.error(f"Error in edit_image: {str(e)}")
        raise RuntimeError(f"Failed to edit image: {str(e)}")

def main():
    # Ensure REPLICATE_API_TOKEN is set
    if not os.environ.get("REPLICATE_API_TOKEN"):
        logger.warning("REPLICATE_API_TOKEN not found in environment variables.")
    
    mcp.run()

if __name__ == "__main__":
    main()

