from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('transcribe_audio/', views.transcribe_audio, name='transcribe_audio'),
    path('predict_next_token/', views.predict_next_token, name='predict_next_token'),
    path('predict_word_completion/', views.predict_word_completion, name='predict_word_completion'),
]
