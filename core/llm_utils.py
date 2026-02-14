import logging
from typing import List

from django.conf import settings
from langchain.output_parsers import OutputFixingParser
from langchain_core.output_parsers import PydanticOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Define the expected output structure
class TokenList(BaseModel):
    tokens: List[str] = Field(description="A list of 15 distinct lowercase string suggestions (nouns/verbs)")

def get_llm():
    """
    Returns a configured ChatOpenAI instance based on settings.
    """
    if settings.USE_LOCAL_LLM:
        # Local Ollama (OpenAI compatible)
        return ChatOpenAI(
            base_url=settings.OLLAMA_API_BASE,
            api_key="ollama",  # Dummy key
            model=settings.MISTRAL_MODEL_NAME,
            temperature=0.3,
            max_tokens=256 # Limit output
        )
    else:
        # Mistral API via OpenAI SDK compatibility (or direct OpenAI if configured for that)
        # Assuming MISTRAL_API_KEY is used with Mistral endpoint via OpenAI client
        return ChatOpenAI(
            base_url="https://api.mistral.ai/v1",
            api_key=settings.MISTRAL_API_KEY,
            model="ministral-3b-latest",
            temperature=0.3,
            max_tokens=256
        )

# Initialize parser
parser = PydanticOutputParser(pydantic_object=TokenList)

# Create a robust fixing parser that can retry once if JSON is malformed
# This requires an LLM to "fix" the output, which we reuse the main LLM for
def get_parser(llm):
    return OutputFixingParser.from_llm(parser=parser, llm=llm)

def predict_next_token_chain(sentence: str):
    llm = get_llm()
    fixing_parser = get_parser(llm)

    system_prompt = (
        "You are an AI assistant helping a stroke patient with Anomia. "
        "Your task is to predict the next *meaningful content word* the user intends to say.\n\n"
        "Patients often forget:\n"
        "1. Specific Nouns (Food, Drink, Nature, Gardening, Entertainment, Places, Clothes, Proper Nouns)\n"
        "2. Action Verbs (e.g., 'cutting', 'walking')\n\n"
        "Guidelines:\n"
        "- PRIORITIZE concrete, high-imageability nouns and action verbs.\n"
        "- AVOID abstract concepts (low-imageability) if a concrete word fits.\n"
        "- STRICTLY AVOID filler words, prepositions, articles, and conjunctions (e.g., the, a, is, and, of, to).\n"
        "- Return a JSON object with a single key 'tokens' containing a list of 15 strings.\n"
        "{format_instructions}"
    )

    prompt = ChatPromptTemplate.from_messages([
        ("system", system_prompt),
        ("user", "The user is speaking a sentence. usage context: '{sentence}'. What are the 15 most likely *content words* (nouns/verbs) the user wants to say next?")
    ])

    chain = prompt | llm | fixing_parser

    try:
        result = chain.invoke({
            "sentence": sentence,
            "format_instructions": parser.get_format_instructions()
        })
        return result.tokens
    except Exception as e:
        logger.error(f"LangChain prediction failed: {e}")
        return []

def predict_word_completion_chain(sentence: str, partial: str):
    llm = get_llm()
    fixing_parser = get_parser(llm)

    system_prompt = (
        "You are an AI assistant helping a stroke patient with Anomia. "
        "The user has said a partial sound/word. Predict the full word they are trying to retrieve.\n\n"
        "Focus on the vocabulary often lost by Anomia patients:\n"
        "- Specific Concrete Nouns (Food: coffee, bread; Nature: tree, garden; Places, Clothes)\n"
        "- Action Verbs\n"
        "- Avoid abstract concepts.\n"
        "- Be aware of phonemic errors (e.g. 'hos-ti-pal').\n"
        "- Return a JSON object with a single key 'tokens' containing a list of 15 strings.\n"
        "{format_instructions}"
    )

    prompt = ChatPromptTemplate.from_messages([
        ("system", system_prompt),
        ("user", "Context: {sentence}\nPartial sound: '{partial}'.\nList the 15 most likely full meaningful words.")
    ])

    chain = prompt | llm | fixing_parser

    try:
        result = chain.invoke({
            "sentence": sentence,
            "partial": partial,
            "format_instructions": parser.get_format_instructions()
        })
        return result.tokens
    except Exception as e:
        logger.error(f"LangChain completion failed: {e}")
        # Fallback to returning the partial if fails
        return [partial]
