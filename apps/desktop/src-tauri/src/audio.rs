use std::process::Command;
use std::thread;

// Áudio da intro é tocado pelo backend porque o WebKitGTK usado pelo Tauri no Linux
// não roteia Web Audio corretamente para a saída de som. Rodio acessa ALSA/Pulse diretamente.
#[tauri::command]
pub fn play_boot_sound() {
    thread::spawn(|| {
        let (_stream, handle) = match rodio::OutputStream::try_default() {
            Ok(v) => v,
            Err(_) => return, // falha silenciosa: não há dispositivo de áudio disponível
        };

        let sink = match rodio::Sink::try_new(&handle) {
            Ok(s) => s,
            Err(_) => return, // falha silenciosa: não foi possível criar o mixer
        };

        let sample_rate = 44100u32;
        let dur = 1.3f32;
        let n = (sample_rate as f32 * dur) as usize;

        let mut samples: Vec<f32> = Vec::with_capacity(n);
        let mut phase = 0f32;

        for i in 0..n {
            let t = i as f32 / sample_rate as f32;
            let prog = (t / dur).min(1.0);

            // Sweep exponencial de 120 Hz até 880 Hz
            let freq = 120.0 * (880.0f32 / 120.0).powf(prog);
            phase += 2.0 * std::f32::consts::PI * freq / (sample_rate as f32);

            // Envelope: ataque rápido + decaimento longo
            let env = if t < 0.05 {
                t / 0.05
            } else {
                (1.0 - (t - 0.05) / (dur - 0.05)).max(0.0)
            };

            let mut s = phase.sin() * env * 0.25f32;

            // Adiciona um brilho extra entre 0.2s e 0.6s
            if t > 0.2 && t < 0.6 {
                let pt = t - 0.2;
                let penv = (1.0 - pt / 0.4f32).max(0.0);
                s += (2.0 * std::f32::consts::PI * 1200.0 * t).sin() * penv * 0.15;
            }

            samples.push(s);
        }

        let buf = rodio::buffer::SamplesBuffer::new(1, sample_rate, samples);
        sink.append(buf);
        sink.sleep_until_end(); // aguarda o término antes de matar a thread
    });
}

// Síntese de voz também fica no backend para não depender do navegador embutido.
// Usa spd-say do sistema, já que o WebKitGTK não expõe TTS confiável.
#[tauri::command]
pub fn speak_greeting(text: String) {
    thread::spawn(move || {
        let _ = Command::new("spd-say")
            .arg("-l")
            .arg("pt-BR")
            .arg("-w")
            .arg(&text)
            .status();
        // erros são ignorados: se o spd-say não estiver instalado, não travamos o app
    });
}