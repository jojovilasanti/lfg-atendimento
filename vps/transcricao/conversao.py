"""Áudio gravado no painel vira mensagem de voz do WhatsApp.

O navegador grava em WebM (Chrome), MP4 (Safari) ou Ogg (Firefox); o WhatsApp
só mostra como mensagem de voz o Ogg com Opus mono. Aqui o áudio é decodificado
e codificado de novo nesse formato, com o PyAV que a transcrição já usa.
"""
import io
from fractions import Fraction

import av

TAXA = 48000
AMOSTRAS_POR_QUADRO = 960  # 20 ms, o tamanho de quadro que o Opus pede


def para_ogg_opus(entrada: bytes) -> bytes:
    saida = io.BytesIO()
    origem = av.open(io.BytesIO(entrada))
    destino = av.open(saida, mode="w", format="ogg")
    try:
        fluxo = destino.add_stream("libopus", rate=TAXA)
        fluxo.codec_context.layout = "mono"
        fluxo.codec_context.bit_rate = 32000
        reamostrar = av.AudioResampler(format="s16", layout="mono", rate=TAXA)
        fila = av.AudioFifo()
        posicao = 0

        def codificar(quadro):
            nonlocal posicao
            if quadro is not None:
                quadro.pts = posicao
                quadro.time_base = Fraction(1, TAXA)
                posicao += quadro.samples
            for pacote in fluxo.encode(quadro):
                destino.mux(pacote)

        def guardar(pedacos):
            for pedaco in pedacos:
                pedaco.pts = None
                fila.write(pedaco)
            while fila.samples >= AMOSTRAS_POR_QUADRO:
                codificar(fila.read(AMOSTRAS_POR_QUADRO))

        for quadro in origem.decode(audio=0):
            quadro.pts = None
            guardar(reamostrar.resample(quadro))
        guardar(reamostrar.resample(None))
        # O último pedaço é completado com silêncio até um quadro inteiro.
        if fila.samples:
            resto = fila.read()
            silencio = av.AudioFrame(format="s16", layout="mono", samples=AMOSTRAS_POR_QUADRO - resto.samples)
            for plano in silencio.planes:
                plano.update(bytes(plano.buffer_size))
            silencio.sample_rate = TAXA
            guardar([resto, silencio])
        codificar(None)
    finally:
        destino.close()
        origem.close()
    return saida.getvalue()
