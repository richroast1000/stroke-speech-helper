import json
import logging
import math
import os
import tempfile

from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
import openai

from .llm_utils import predict_next_token_chain, predict_word_completion_chain

logger = logging.getLogger(__name__)

# Initialize OpenAI client (make sure API key is set)
# If settings.OPENAI_API_KEY is None, the client might fail on init or call.
client = openai.OpenAI(api_key=settings.OPENAI_API_KEY)

def index(request):
    return render(request, 'index.html')

@csrf_exempt
def transcribe_audio(request):
    if request.method == 'POST':
        if 'audio' not in request.FILES:
            return JsonResponse({'error': 'No audio file provided'}, status=400)
        
        audio_file = request.FILES['audio']
        
        # Save temp file
        # We need a file extension for Whisper to recognize format, usually .webm from browser
        suffix = '.webm'
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_audio:
            for chunk in audio_file.chunks():
                temp_audio.write(chunk)
            temp_audio_path = temp_audio.name

        try:
            with open(temp_audio_path, 'rb') as audio:
                transcription = client.audio.transcriptions.create(
                    model="whisper-1", 
                    file=audio,
                    language="en",
                    response_format="verbose_json"
                )
            
            text = transcription.text
            
            # Calculate confidence from segments estimate
            # segments is a list, we might have multiple if long speech, 
            # but usually one for short commands.
            # We'll take the average of segment confidence or just the first.
            confidence = 0.0
            if hasattr(transcription, 'segments') and transcription.segments:
                try:
                    # Try attribute access first (Pydantic model)
                    probs = [math.exp(s.avg_logprob) for s in transcription.segments]
                    confidence = sum(probs) / len(probs)
                except AttributeError:
                    # Fallback to dictionary access
                    try:
                         probs = [math.exp(s['avg_logprob']) for s in transcription.segments]
                         confidence = sum(probs) / len(probs)
                    except:
                        confidence = 0.0
            
            # If no segments or confidence failed, default to 1.0 to assume it's a good word
            # unless the text is empty or very short? 
            # No, if we fail to calc confidence, better to assume it's OK than to block it 
            # because the user says "words aren't being displayed".
            # The previous code defaulted to 0.0 which triggered the "partial" logic.
            # Filter out common Whisper hallucinations
            HALLUCINATIONS = {
                "thank you for watching",
                "thanks for watching",
                "subscribe",
                "amara.org",
                "mbc",
                "you", # Often hallucinated in silence
                ".",
                "bye",
                "subtitles by",
                "copyright",
                "all rights reserved"
            }
            
            clean_text = text.strip().lower()
            # Remove punctuation for check
            clean_text_check = clean_text.replace(".", "").replace("!", "").replace("?", "")
            
            # Check for exact matches or "thank you for watching" containment
            if clean_text_check in HALLUCINATIONS or "thank you for watching" in clean_text or "thanks for watching" in clean_text:
                text = ""
                confidence = 0.0

            if confidence == 0.0 and text:
                confidence = 1.0

            return JsonResponse({'text': text, 'confidence': confidence})
        except Exception as e:
            # print(f"Error: {e}") 
            return JsonResponse({'error': str(e)}, status=500)
        finally:
            # Clean up
            if os.path.exists(temp_audio_path):
                os.remove(temp_audio_path)

    return JsonResponse({'error': 'Invalid method'}, status=405)

@csrf_exempt
def predict_next_token(request):
    if request.method == 'POST':
        try:
            data = json.loads(request.body)
            sentence = data.get('sentence', '')
            
            logger.info(f"Predicting next token for sentence: '{sentence}'")
            tokens = predict_next_token_chain(sentence)
            return JsonResponse({'tokens': tokens})
        
        except Exception as e:
            logger.error(f"Error in predict_next_token: {e}", exc_info=True)
            return JsonResponse({'error': str(e)}, status=500)
            
    return JsonResponse({'error': 'Invalid method'}, status=405)

@csrf_exempt
def predict_word_completion(request):
    """
    Predicts the full word based on a sentence context and a partial syllable/token.
    """
    if request.method == 'POST':
        try:
            data = json.loads(request.body)
            sentence = data.get('sentence', '')
            partial = data.get('partial', '')
            
            if not partial:
                 return JsonResponse({'tokens': []})

            logger.info(f"Predicting word completion for partial: '{partial}' in sentence: '{sentence}'")
            tokens = predict_word_completion_chain(sentence, partial)
            return JsonResponse({'tokens': tokens})

        except Exception as e:
            logger.error(f"Error in predict_word_completion: {e}", exc_info=True)
            return JsonResponse({'error': str(e)}, status=500)
            
    return JsonResponse({'error': 'Invalid method'}, status=405)
