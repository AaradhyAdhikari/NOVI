# "Hey Novi" keyword spotting model

sherpa-onnx streaming zipformer keyword spotter, `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`
(int8 files, renamed), from https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models.
License: Apache License 2.0 (k2-fsa / sherpa-onnx). Idea for using keyword spotting as the wake
word: Dodaios (https://github.com/Dodaios/Dodaios, Apache License 2.0).

`keywords.txt`: one wake phrase per line, written in the model's BPE pieces, then `@NAME`.
"HEY NOVI" = `▁HE Y ▁NO VI` (made with the model's bpe.model and sentencepiece).
