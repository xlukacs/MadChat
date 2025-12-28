import os
import replicate
import logging
import re
from typing import List, Optional
from mcp.server.fastmcp import FastMCP

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("replicate-image-mcp")

# Initialize FastMCP server
mcp = FastMCP("Replicate Image Server")

# Model identifiers
# Note: Ensure these match the exact identifiers on Replicate
DEFAULT_GENERATION_MODEL = "google/imagen-4-fast"  # For image generation
DEFAULT_EDIT_MODEL = "openai/gpt-image-1.5"  # For image editing

# Pattern to match image URLs
IMAGE_URL_PATTERN = re.compile(
    r'https?://[^\s"\'<>]+\.(?:jpg|jpeg|png|gif|webp|bmp|svg)',
    re.IGNORECASE
)
REPLICATE_DELIVERY_PATTERN = re.compile(
    r'https?://replicate\.delivery/[^\s"\'<>]+',
    re.IGNORECASE
)
DATA_URI_PATTERN = re.compile(
    r'data:image/[^;]+;base64,[^\s"\'<>]+',
    re.IGNORECASE
)

def extract_image_urls(text: str) -> List[str]:
    """Extract image URLs from text."""
    urls = []
    
    # Check for data URIs
    data_uris = DATA_URI_PATTERN.findall(text)
    urls.extend(data_uris)
    
    # Check for replicate delivery URLs
    replicate_urls = REPLICATE_DELIVERY_PATTERN.findall(text)
    urls.extend(replicate_urls)
    
    # Check for standard image URLs
    image_urls = IMAGE_URL_PATTERN.findall(text)
    urls.extend(image_urls)
    
    # Remove duplicates while preserving order
    seen = set()
    unique_urls = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            unique_urls.append(url)
    
    return unique_urls

def find_image_from_context(context: Optional[str] = None) -> Optional[str]:
    """Find the last image URL from conversation context."""
    if not context:
        return None
    
    urls = extract_image_urls(context)
    if urls:
        # Return the last (most recent) image URL
        return urls[-1]
    return None

@mcp.tool()
async def generate_image(
    prompt: str, 
    num_outputs: int = 1,
    model: str = DEFAULT_GENERATION_MODEL
) -> List[str]:
    """
    Generate images from a text prompt using a Replicate model.
    
    Args:
        prompt: Text description of the image to generate.
        num_outputs: Number of images to generate (1-4).
        model: Replicate model identifier (defaults to google/imagen-4-fast).
    """
    logger.info(f"Generating image with model {model} and prompt: {prompt}")
    
    try:
        # replicate.run is synchronous by default in the library, 
        # but FastMCP handles sync/async tools correctly.
        output = replicate.run(
            model,
            input={
                "prompt": prompt,
                "aspect_ratio": "4:3",
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
    prompt: str,
    image_url: Optional[str] = None,
    conversation_context: Optional[str] = None,
    num_outputs: int = 1,
    model: str = DEFAULT_EDIT_MODEL
) -> List[str]:
    """
    Edit or transform an existing image using a text prompt.
    
    IMPORTANT: The image_url parameter is OPTIONAL. If not provided, the system will automatically
    extract the most recent image from the conversation context. You can call this tool with just
    the prompt parameter, and it will automatically use the last image in the conversation.
    
    The image can be provided in three ways:
    1. Automatically extracted from conversation (default - you don't need to provide image_url)
    2. Explicitly via the image_url parameter (if you want to use a specific image)
    3. From environment variable CONVERSATION_IMAGES (fallback)
    
    Args:
        prompt: Instructions for how to edit or transform the image (REQUIRED).
        image_url: Optional URL of the image to edit. If omitted, the last image from the conversation will be used automatically.
        conversation_context: Optional conversation text to search for image URLs (usually auto-populated).
        num_outputs: Number of variations to generate (1-4, default: 1).
        model: Replicate model identifier (defaults to openai/gpt-image-1.5).
    
    Returns:
        List of image URLs. Returns empty list if no image is found.
    
    Example usage:
        - edit_image(prompt="Make the background blue")  # Uses last image automatically
        - edit_image(prompt="Add a giraffe", image_url="https://...")  # Uses specific image
    """
    # Determine which image URL to use
    final_image_url = image_url
    
    if not final_image_url:
        # Try to find from conversation context
        if conversation_context:
            final_image_url = find_image_from_context(conversation_context)
            if final_image_url:
                logger.info(f"Found image URL from conversation context: {final_image_url}")
        
        # If still not found, try environment variable
        if not final_image_url:
            env_images = os.environ.get("CONVERSATION_IMAGES", "")
            if env_images:
                urls = [url.strip() for url in env_images.split(",") if url.strip()]
                if urls:
                    final_image_url = urls[-1]  # Use last image
                    logger.info(f"Found image URL from environment: {final_image_url}")
    
    # If no image is provided, return early without executing the edit
    if not final_image_url:
        logger.warning(
            "edit_image called but no image URL provided. "
            "Please provide image_url parameter, or ensure conversation_context contains an image URL, "
            "or set CONVERSATION_IMAGES environment variable. Skipping edit operation."
        )
        return []
    
    logger.info(f"Editing image {final_image_url} with model {model} and prompt: {prompt}")
    
    try:
        output = replicate.run(
            model,
            input={
                "image": final_image_url,
                "prompt": prompt,
                "aspect_ratio": "3:2",
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

