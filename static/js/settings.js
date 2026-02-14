// settings.js
// Configuration for Speech Assistant

window.APP_SETTINGS = {
    // Time in milliseconds to wait after speech stops before triggering next word prediction
    PREDICTION_PAUSE_DELAY: 1500,

    // Time in milliseconds to wait after speech stops before processing audio (silence detection)
    SILENCE_THRESHOLD: 1000,

    // Audio volume threshold (0-255) to trigger recording
    VOLUME_THRESHOLD: 50,

    // Minimum words required in a sentence before attempting prediction
    MIN_WORDS_FOR_PREDICTION: 3,

    // Confidence threshold (0.0 - 1.0). Transcriptions below this are treated as partial/unsure.
    CONFIDENCE_THRESHOLD: 0.4
};
