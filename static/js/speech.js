document.addEventListener('DOMContentLoaded', () => {
    const sentenceContainer = document.getElementById('sentence-container');
    const historyContainer = document.getElementById('history-container');
    const predictionContainer = document.getElementById('prediction-container');
    const predictionsList = document.getElementById('predictions');
    const toggleBtn = document.getElementById('toggle-recording');
    const clearBtn = document.getElementById('clear-conversation');
    const statusText = document.getElementById('status-text');
    const editModal = document.getElementById('edit-modal');
    const editInput = document.getElementById('edit-input');
    const saveEditBtn = document.getElementById('save-edit');
    const cancelEditBtn = document.getElementById('cancel-edit');
    const addFullStopBtn = document.getElementById('add-full-stop');
    const morePredictionsBtn = document.getElementById('more-predictions');

    let words = []; // Array of {id, text}
    let isRecording = false;
    let mediaRecorder;
    let audioChunks = [];
    let audioContext;
    let analyser;
    let microphone;
    let silenceStart = Date.now();
    let isSpeaking = false;
    let silenceTimer = null;
    let currentEditId = null;
    let speechFrameCount = 0; // Counter for valid speech frames

    // Prediction state
    let allPredictions = [];
    let currentPredictionIndex = 0;
    const PREDICTION_PAGE_SIZE = 5;

    // Configuration
    // Configuration load from global settings object (injected via settings.js)
    const SILENCE_THRESHOLD = window.APP_SETTINGS?.SILENCE_THRESHOLD || 1000;
    const VOLUME_THRESHOLD = window.APP_SETTINGS?.VOLUME_THRESHOLD || 50;
    const MIN_WORDS_FOR_PREDICTION = window.APP_SETTINGS?.MIN_WORDS_FOR_PREDICTION || 3;
    const CONFIDENCE_THRESHOLD = window.APP_SETTINGS?.CONFIDENCE_THRESHOLD || 0.5;
    const PREDICTION_PAUSE_DELAY = window.APP_SETTINGS?.PREDICTION_PAUSE_DELAY || 1500;

    // List of common words to accept even if confidence is low
    const COMMON_WORDS = new Set([
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
        "is", "are", "was", "were", "be", "been", "am", "it", "this", "that", "these", "those",
        "so", "then", "if", "when", "as", "from", "into", "up", "out", "about", "over", "under",
        "he", "she", "they", "them", "his", "her", "my", "your", "our", "their", "i", "we", "you",
        "just", "like", "well", "um", "uh", "very", "really", "so", "oh", "yes", "no", "ok", "okay"
    ]);

    // --- Audio Handling ---

    async function startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            microphone = audioContext.createMediaStreamSource(stream);
            microphone.connect(analyser);
            analyser.fftSize = 256;

            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

            mediaRecorder.ondataavailable = event => {
                if (event.data.size > 0) audioChunks.push(event.data);
            };

            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                audioChunks = [];
                const currentFrameCount = speechFrameCount;

                // Restart if still "recording" mode (toggle hasn't successfully turned off)
                if (isRecording) {
                    speechFrameCount = 0; // Reset for next chunk
                    try {
                        mediaRecorder.start();
                    } catch (e) {
                        console.error("Failed to restart recorder:", e);
                        stopRecording();
                        statusText.textContent = "Error restarting recorder.";
                        return;
                    }
                }

                // Only act on this chunk if we had enough valid speech frames
                // 10 frames @ 60fps ~= 160ms of audio above threshold
                if (currentFrameCount > 10 && audioBlob.size > 1000) {
                    statusText.textContent = "Transcribing...";
                    sendAudio(audioBlob).finally(() => {
                        if (isRecording) statusText.textContent = "Listening...";
                    });
                } else {
                    console.log(`Discarding audio: Frame count ${currentFrameCount}, Blob size ${audioBlob.size}`);
                }
            };

            speechFrameCount = 0;
            mediaRecorder.start();
            isRecording = true;
            toggleBtn.classList.add('recording');
            toggleBtn.textContent = "Stop Listening";
            statusText.textContent = "Listening...";

            checkSilence(); // Start checking loop

        } catch (err) {
            console.error("Error accessing microphone:", err);
            statusText.textContent = "Error accessing microphone. Please allow permissions.";
        }
    }

    function stopRecording() {
        isRecording = false;
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        if (audioContext) {
            audioContext.close();
        }
        toggleBtn.classList.remove('recording');
        toggleBtn.textContent = "Start Listening";
        statusText.textContent = "Ready";
        cancelAnimationFrame(silenceTimer);
    }

    function checkSilence() {
        if (!isRecording) return;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);

        // Calculate average volume
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        const average = sum / dataArray.length;

        if (average > VOLUME_THRESHOLD) {
            // Sound detected
            speechFrameCount++; // Increment valid speech frame counter
            if (predictionTimer) {
                clearTimeout(predictionTimer);
                predictionTimer = null;
                statusText.textContent = "Listening...";
            }
            if (!isSpeaking) {
                isSpeaking = true;
                // console.log("Speech started");
            }
            silenceStart = Date.now();
        } else {
            // Silence
            if (isSpeaking) {
                const silenceDuration = Date.now() - silenceStart;
                if (silenceDuration > SILENCE_THRESHOLD) {
                    // console.log("Silence detected, chunking.");
                    isSpeaking = false;
                    // Trigger stop/start to flush buffer
                    if (mediaRecorder.state === 'recording') {
                        mediaRecorder.stop(); // This triggers onstop, which sends data and restarts

                        // Start timer for prediction if we have enough words
                        // But wait for transcription to come back first? 
                        // The actual flow is: stop -> onstop -> sendAudio -> addWord -> (wait) -> getPredictions
                        // So we should handle the delay inside addWord or a separate logic?
                        // The user says "The next word in the sentence should be predicted only when the user next pauses."
                        // Silence detected IS the pause.
                        // So we should trigger prediction after a delay from silence start?
                        // Actually, the transcription takes time. 
                        // Let's rely on the fact that silence detected -> processing -> word added.
                        // After word added, we should wait?
                        // No, the "pause" has already happened (silence).
                        // If the user starts speaking again quickly, we cancel.

                        // Revised Logic:
                        // 1. User speaks -> Silence detected -> Processing -> Word Added.
                        // 2. Clear previous predictions immediately when word added.
                        // 3. To "predict only when user next pauses":
                        //    - We need to know if the silence continues.
                        //    - Current logic: silence > 1s -> chunk sent.
                        //    - We can trigger a delayed prediction after the chunk is sent.
                        //    - If user speaks again, that timer should be cancelled.

                        // However, we only get the WORD back after the API call.
                        // So: sendAudio -> returns text -> addWord.
                        // INSIDE addWord, we should schedule the prediction? 
                        // Or just schedule it from here?
                        // Let's modify addWord to NOT call getPredictions immediately.
                        // Instead, we set a timeout here.
                    }
                }
            }
        }

        silenceTimer = requestAnimationFrame(checkSilence);
    }

    // --- API Interactions ---

    async function sendAudio(blob) {
        const formData = new FormData();
        formData.append('audio', blob, 'recording.webm');

        try {
            const response = await fetch('/transcribe_audio/', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            if (data.text && data.text.trim()) {
                const text = data.text.trim();
                const lowerText = text.toLowerCase().replace(/[.,!?;:]+$/, "");

                // Check confidence if available
                const confidence = data.confidence !== undefined ? data.confidence : 1.0;

                // If it's a common word, accept it regardless of confidence
                const isCommon = COMMON_WORDS.has(lowerText);

                // Check if predictions are currently active (user paused and sees suggestions)
                const arePredictionsVisible = predictionsList.children.length > 0;

                // If predictions are visible, be more lenient with confidence to assume user is selecting/continuing
                let effectiveThreshold = CONFIDENCE_THRESHOLD;
                if (arePredictionsVisible) {
                    effectiveThreshold = 0.2; // Much lower threshold when continuing

                    // Check if it matches a prediction
                    const predChips = document.querySelectorAll('.prediction-chip');
                    for (let i = 0; i < predChips.length; i++) {
                        if (predChips[i].textContent.trim().toLowerCase() === lowerText) {
                            effectiveThreshold = 0.0; // Always accept if it matches a prediction
                            break;
                        }
                    }
                    console.log(`Predictions visible. Lowering threshold: ${effectiveThreshold}`);
                }

                if (confidence < effectiveThreshold && !isCommon) {
                    console.log(`Low confidence (${confidence.toFixed(2)}) and not common. Treating as partial.`);
                    getWordCompletions(text);
                    // Feedback to user
                    statusText.textContent = `Unsure. Did you mean one of these?`;
                } else {
                    addWord(text);
                    // Schedule prediction after delay if no new speech is detected
                    schedulePrediction();
                }
            }
        } catch (err) {
            console.error("Transcription error:", err);
            statusText.textContent = "Error transcribing.";
        }
    }

    let predictionTimer = null;

    function schedulePrediction() {
        if (predictionTimer) clearTimeout(predictionTimer);

        // Only schedule if not currently speaking? 
        // If user started speaking again during transcription, isSpeaking would be true.
        if (isSpeaking) return;

        statusText.textContent = `Waiting ${PREDICTION_PAUSE_DELAY}ms for pause...`;

        predictionTimer = setTimeout(() => {
            if (!isSpeaking) {
                statusText.textContent = "Predicting...";
                getPredictions();
            }
        }, PREDICTION_PAUSE_DELAY);
    }

    // Hook into checkSilence to cancel timer if speech starts
    // We need to modify checkSilence or add a watcher.
    // Let's modify the variable watcher in checkSilence.

    // ... inside checkSilence ...
    //   if (average > VOLUME_THRESHOLD) {
    //      if (predictionTimer) { clearTimeout(predictionTimer); predictionTimer = null; }
    //   }

    async function getPredictions() {
        if (words.length < MIN_WORDS_FOR_PREDICTION) {
            predictionsList.innerHTML = '';
            // predictionContainer.classList.add('hidden'); // Removed to keep layout fixed
            return;
        }

        // Construct sentence
        const sentence = words.map(w => w.text).join(' ');

        try {
            const response = await fetch('/predict_next_token/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sentence: sentence })
            });
            const data = await response.json();

            // Only render if we haven't started speaking again
            if (!isSpeaking) {
                if (data.tokens && data.tokens.length > 0) {
                    renderPredictions(data.tokens);
                    statusText.textContent = "Ready";
                } else {
                    predictionsList.innerHTML = '';
                    // predictionContainer.classList.add('hidden'); // Removed
                    statusText.textContent = "Ready";
                }
            }
        } catch (err) {
            console.error("Prediction error:", err);
            statusText.textContent = "Error predicting.";
        }
    }

    async function getWordCompletions(partial) {
        // Construct sentence context
        const sentence = words.map(w => w.text).join(' ');

        try {
            const response = await fetch('/predict_word_completion/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sentence: sentence, partial: partial })
            });
            const data = await response.json();

            if (data.tokens && data.tokens.length > 0) {
                renderPredictions(data.tokens);
                // predictionContainer.classList.remove('hidden'); // Always visible
                document.querySelector('#prediction-container h3').textContent = `Suggestions for "${partial}":`;
            } else {
                // If no completions, maybe just add the word anyway?
                // or just fail silently. Let's add the word if we can't complete it.
                addWord(partial);
            }
        } catch (err) {
            console.error("Completion error:", err);
            addWord(partial); // Fallback
        }
    }

    // --- UI Logic ---

    function addWord(text) {
        // Handle multiple words if transcription returns a phrase
        const newWords = text.split(/\s+/);
        newWords.forEach(w => {
            // Normalize: lowercase and remove any trailing periods or punctuation
            let cleanWord = w.toLowerCase().replace(/[.,!?;:]+$/, "");
            if (cleanWord) words.push({ id: Date.now() + Math.random(), text: cleanWord });
        });

        renderWords();
        // Clear predictions immediately when a new word is added
        predictionsList.innerHTML = '';
        // predictionContainer.classList.add('hidden'); // Removed
        if (morePredictionsBtn) morePredictionsBtn.classList.add('hidden');

        // Reset prediction state
        allPredictions = [];
        currentPredictionIndex = 0;

        // Schedule next prediction
        schedulePrediction();
    }

    function renderWords() {
        sentenceContainer.innerHTML = '';
        if (historyContainer) historyContainer.innerHTML = '';

        if (words.length === 0) {
            const placeholder = document.createElement('div');
            placeholder.className = 'placeholder-text';
            placeholder.textContent = 'Start speaking...';
            sentenceContainer.appendChild(placeholder);
            // No return here, because we might have history even if words is empty? 
            // wait, words array contains ALL words, including history.
            // If words is empty, conversation is cleared.
            return;
        }

        // Group words into completed sentences and the current active sentence
        let completedSentences = [];
        let currentSentenceWords = [];
        let tempSentence = [];

        words.forEach((word) => {
            tempSentence.push(word);
            if (word.text.endsWith('.')) {
                completedSentences.push(tempSentence);
                tempSentence = [];
            }
        });
        currentSentenceWords = tempSentence;

        // Render completed sentences as plain text blocks in history container
        completedSentences.forEach(sentenceWords => {
            const sentenceText = sentenceWords.map(w => w.text).join(' ');
            const p = document.createElement('p');
            p.className = 'completed-sentence';
            p.textContent = sentenceText;
            if (historyContainer) {
                historyContainer.appendChild(p);
                // Auto-scroll to bottom of history
                historyContainer.scrollTop = historyContainer.scrollHeight;
            } else {
                // Fallback if no history container found (shouldn't happen)
                sentenceContainer.appendChild(p);
            }
        });

        // Render current unfinished sentence as word chips
        currentSentenceWords.forEach((wordObj) => {
            // Calculate index within the global words array for deletion logic
            // Because we need to delete from the *global* array.
            const globalIndex = words.findIndex(w => w.id === wordObj.id);

            const chip = document.createElement('div');
            chip.className = 'word-chip';

            const textSpan = document.createElement('span');
            textSpan.className = 'word-text';
            textSpan.textContent = wordObj.text;
            chip.appendChild(textSpan);

            // Controls
            const controls = document.createElement('div');
            controls.className = 'word-controls';

            // Edit button (all words)
            const editBtn = document.createElement('button');
            editBtn.className = 'btn-icon';
            editBtn.innerHTML = '✎'; // Pencil icon
            editBtn.onclick = () => openEditModal(wordObj.id);
            controls.appendChild(editBtn);

            // Delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn-icon btn-delete';
            deleteBtn.innerHTML = '✕'; // Cross icon
            deleteBtn.onclick = () => deleteWord(wordObj.id);

            // Highlight subseqent words on hover
            deleteBtn.onmouseenter = () => {
                const chips = document.querySelectorAll('.word-chip');
                // We need to find the specific chip index in the DOM list
                // Since completed sentences are just <p>, the chips list only contains current sentence words.
                // We can just iterate from the current chip's DOM index to end.

                // Find index of this chip in the current render list
                let currentChipIndex = -1;
                for (let i = 0; i < chips.length; i++) {
                    if (chips[i] === chip) {
                        currentChipIndex = i;
                        break;
                    }
                }

                if (currentChipIndex !== -1) {
                    for (let i = currentChipIndex; i < chips.length; i++) {
                        chips[i].classList.add('delete-highlight');
                    }
                }
            };
            deleteBtn.onmouseleave = () => {
                const chips = document.querySelectorAll('.word-chip');
                for (let i = 0; i < chips.length; i++) {
                    chips[i].classList.remove('delete-highlight');
                }
            };

            controls.appendChild(deleteBtn);

            chip.appendChild(controls);
            sentenceContainer.appendChild(chip);
        });

        // Reset prediction header text when rendering normal words/predictions
        const predHeader = document.querySelector('#prediction-container h3');
        if (predHeader) predHeader.textContent = "Suggested Next Token:";
    }

    function renderPredictions(tokens) {
        predictionsList.innerHTML = '';
        // predictionContainer.classList.remove('hidden'); // Always visible

        // Hide pagination button if it exists
        if (morePredictionsBtn) morePredictionsBtn.classList.add('hidden');

        // We want 3 rows of up to 5 words each
        const batchSize = 5;
        // Total rows to display (up to 3)
        const rowCount = Math.ceil(tokens.length / batchSize);

        for (let i = 0; i < Math.min(rowCount, 3); i++) {
            const start = i * batchSize;
            const end = start + batchSize;
            const batch = tokens.slice(start, end);

            if (batch.length === 0) continue;

            const rowDiv = document.createElement('div');
            rowDiv.className = `prediction-row priority-${i + 1}`;

            batch.forEach(token => {
                const chip = document.createElement('div');
                chip.className = 'prediction-chip';
                chip.textContent = token.toLowerCase();
                chip.onclick = () => addWord(token);
                rowDiv.appendChild(chip);
            });

            predictionsList.appendChild(rowDiv);
        }
    }

    // Deprecated pagination functions removed
    // function displayCurrentPredictionSet() { ... }
    // function loadNextPredictions() { ... }

    function deleteWord(id) {
        // Find index of word to delete
        const index = words.findIndex(w => w.id === id);
        if (index !== -1) {
            // Delete that word and everything after it
            words = words.slice(0, index);
            renderWords();
            getPredictions();
        }
    }

    function openEditModal(id) {
        const wordObj = words.find(w => w.id === id);
        if (!wordObj) return;

        currentEditId = id;
        editInput.value = wordObj.text;
        editModal.classList.remove('hidden');
        editInput.focus();
    }

    function closeEditModal() {
        editModal.classList.add('hidden');
        currentEditId = null;
    }

    function saveEdit() {
        if (!currentEditId) return;
        const newText = editInput.value.trim();

        if (newText) {
            let cleanText = newText.toLowerCase().replace(/[.,!?;:]+$/, "");
            words = words.map(w => w.id === currentEditId ? { ...w, text: cleanText } : w);
            renderWords();
            getPredictions();
        } else {
            // If empty, maybe delete? User didn't specify, but safer to do nothing or delete.
            // Let's assume edit to empty means delete.
            deleteWord(currentEditId);
        }
        closeEditModal();
    }

    // --- Event Listeners ---

    toggleBtn.addEventListener('click', () => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    clearBtn.addEventListener('click', () => {
        words = [];
        renderWords();
        predictionsList.innerHTML = '';
        // predictionContainer.classList.add('hidden'); // Removed
        statusText.textContent = "Conversation cleared.";
    });

    saveEditBtn.addEventListener('click', saveEdit);
    cancelEditBtn.addEventListener('click', closeEditModal);
    if (addFullStopBtn) {
        addFullStopBtn.addEventListener('click', () => {
            if (words.length > 0) {
                const lastWord = words[words.length - 1];
                if (!lastWord.text.endsWith('.')) {
                    // Update in place
                    lastWord.text += '.';
                    renderWords();
                    // Clear predictions as sentence ended
                    predictionsList.innerHTML = '';
                    // predictionContainer.classList.add('hidden'); // Removed
                    if (predictionTimer) clearTimeout(predictionTimer);
                }
            }
        });
    }

    if (morePredictionsBtn) {
        morePredictionsBtn.addEventListener('click', loadNextPredictions);
    }

    // Global keydown handler
    document.addEventListener('keydown', (e) => {
        // Ignore if editing
        if (document.activeElement === editInput) return;

        // Space bar: End of sentence context
        if (e.code === 'Space') {
            e.preventDefault();
            if (words.length > 0) {
                predictionsList.innerHTML = '';
                // predictionContainer.classList.add('hidden'); // Removed
            }
        }
        // Delete key: Remove last word
        else if (e.key === 'Delete') {
            if (words.length > 0) {
                const lastWord = words[words.length - 1];
                deleteWord(lastWord.id);
            }
        }
    });

    // Close modal on outside click
    editModal.addEventListener('click', (e) => {
        if (e.target === editModal) closeEditModal();
    });

    // Enter key in input
    editInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') saveEdit();
    });
});
