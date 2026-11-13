import os
import json
from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel, ValidationError

load_dotenv()
_client = OpenAI(api_key=os.getenv("API_KEY"),
                 base_url=os.getenv("BASE_URL"))
_MODEL = os.getenv("MODEL")

def ask_text(prompt: str, system: str = "You are a travel planner.") -> str:
    reply = _client.chat.completions.create(
        model = _MODEL,
        messages = [{"role": "system", "content": system},
                    {"role": "user", "content": prompt}],
    )
    return reply.choices[0].message.content.strip()

def _clean(text:str) -> str:
    """
    Strip JSON outputs with json fences
    """
    text = text.strip()
    if text.startwith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        text = text.rsplit("```", 1)[0]
    return text.strip()

def ask_json(prompt: str, schema: type[BaseModel], retries: int = 1):
    system = ("Reply with only valid JSON matching the schema. Do not explain or add any additional text.\n"
              + json.dumps(schema.model_json_schema()))
    for i in range (retries + 1):
        raw = ask_text(prompt, system = system)
        try:
            return schema.model_validate_json(_clean(raw))
        except ValidationError:
            continue
    return None