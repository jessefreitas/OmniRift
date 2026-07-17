use chrono::Timelike;
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

// Saudações FRIDAY: 8 WAVs neurais (ElevenLabs, PT-BR) embutidos — Adam (masc) e Ophelia (fem)
// × 4 períodos, frases NEUTRAS (sem gênero de quem opera). Escolhidos pela HORA local + voz.
// Tocados pelo backend via rodio (o WebKitGTK não roteia Web Audio/TTS no Linux). Offline.
static WAV_MORNING_M: &[u8] = include_bytes!("../assets/boot-morning-male.wav");
static WAV_AFTERNOON_M: &[u8] = include_bytes!("../assets/boot-afternoon-male.wav");
static WAV_EVENING_M: &[u8] = include_bytes!("../assets/boot-evening-male.wav");
static WAV_NIGHT_M: &[u8] = include_bytes!("../assets/boot-night-male.wav");
static WAV_MORNING_F: &[u8] = include_bytes!("../assets/boot-morning-female.wav");
static WAV_AFTERNOON_F: &[u8] = include_bytes!("../assets/boot-afternoon-female.wav");
static WAV_EVENING_F: &[u8] = include_bytes!("../assets/boot-evening-female.wav");
static WAV_NIGHT_F: &[u8] = include_bytes!("../assets/boot-night-female.wav");

#[tauri::command]
pub fn play_greeting(voice: String) {
    // Fire-and-forget: não bloqueia a UI.
    thread::spawn(move || {
        // female == "Ophelia"; qualquer outro valor usa "Adam".
        let female = voice == "female";
        // Faixas: manhã 5-11, tarde 12-17, noite 18-23, madrugada 0-4.
        let wav: &[u8] = match (chrono::Local::now().hour(), female) {
            (5..=11, false) => WAV_MORNING_M,
            (12..=17, false) => WAV_AFTERNOON_M,
            (18..=23, false) => WAV_EVENING_M,
            (_, false) => WAV_NIGHT_M,
            (5..=11, true) => WAV_MORNING_F,
            (12..=17, true) => WAV_AFTERNOON_F,
            (18..=23, true) => WAV_EVENING_F,
            (_, true) => WAV_NIGHT_F,
        };
        let (_stream, handle) = match rodio::OutputStream::try_default() {
            Ok(v) => v,
            Err(_) => return,
        };
        let sink = match rodio::Sink::try_new(&handle) {
            Ok(s) => s,
            Err(_) => return,
        };
        let source = match rodio::Decoder::new(std::io::Cursor::new(wav)) {
            Ok(s) => s,
            Err(_) => return,
        };
        sink.append(source);
        sink.sleep_until_end();
    });
}