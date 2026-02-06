
from fastapi import FastAPI
from schemas import RequestSchema, ResponseSchema
from pipeline import handle_request

app = FastAPI(
    title="Adaptive Accessibility Backend",
    description="Backend API for real-time UI adaptation and multimodal content transformation",
    version="1.0.0"
)

@app.post("/process", response_model=ResponseSchema)
def process_request(request: RequestSchema):
    """
    Main endpoint called by the browser extension (frontend).
    Validates input, runs pipeline, and returns actions.
    """
    request_dict = request.model_dump()
    response = handle_request(request_dict)
    return response
