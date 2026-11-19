"""OpenAI-compatible LLM calls. Credentials stay on the Python server."""
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI, OpenAIError
from pydantic import BaseModel, ValidationError

load_dotenv(Path(__file__).with_name('.env'))


class LLMError(RuntimeError):
    pass


def configured() -> bool:
    return bool(os.getenv('API_KEY') and os.getenv('MODEL'))


def ask_text(prompt: str, system: str = 'You are a travel planner.') -> str:
    if not configured():
        raise LLMError('Set API_KEY and MODEL in backend/.env before planning.')
    # Lazy initialization lets health checks and solver tests run without credentials.
    try:
        with OpenAI(api_key=os.environ['API_KEY'], base_url=os.getenv('BASE_URL'),
                    timeout=60.0, max_retries=0) as client:
            reply = client.chat.completions.create(
                model=os.environ['MODEL'],
                messages=[{'role': 'system', 'content': system},
                          {'role': 'user', 'content': prompt}],
            )
    except OpenAIError as exc:
        raise LLMError('The LLM provider could not complete the request. Check the server credentials/model or retry.') from exc
    content = reply.choices[0].message.content if reply.choices else None
    if not content:
        raise LLMError('The LLM returned an empty response. Please retry.')
    return content.strip()


def _clean(text: str) -> str:
    text = text.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else ''
        text = text.rsplit('```', 1)[0]
    return text.strip()


def ask_json(prompt: str, schema: type[BaseModel], retries: int = 1):
    system = ('Return only valid JSON matching this schema. No markdown or explanation.\n'
              + json.dumps(schema.model_json_schema()))
    for attempt in range(retries + 1):
        raw = ask_text(prompt, system=system)
        try:
            return schema.model_validate_json(_clean(raw))
        except ValidationError as exc:
            if attempt == retries:
                raise LLMError('The LLM returned invalid planning constraints. Please retry.') from exc
            fields = [f"{e['loc']}: {e['msg']}" for e in exc.errors()[:10]]
            prompt += '\nYour last response failed validation at: ' + ', '.join(fields)
