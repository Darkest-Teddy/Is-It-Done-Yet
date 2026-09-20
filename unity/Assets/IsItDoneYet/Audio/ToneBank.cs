using System;
using UnityEngine;

namespace IsItDoneYet.Audio
{
    /// <summary>Which sound. Kept as an enum so a caller cannot invent one by typo.</summary>
    public enum Sfx
    {
        MessagePop,
        GoodCut,
        ComboUp,
        StreakBreak,
        Warning,
        StepComplete,
        PointsDocked,
        RankUp,
        PokeClick,
        Hover,
        SafeModeEnter,
    }

    /// <summary>
    /// Every sound in the app, synthesised in C#.
    ///
    /// Zero audio files. That is a licensing decision before it is a footprint one: at a
    /// hackathon, the sample whose provenance nobody can produce is the one that gets a project
    /// disqualified, and "I found it on a free sounds site" is not a licence. Everything here
    /// is arithmetic over a sine, so there is nothing to attribute and nothing to check.
    ///
    /// It is also better for this app. The sounds are tuned in code next to the animation they
    /// have to land with -- the chime's attack is the same 120ms as the toast's slide -- and
    /// retuning one is an edit rather than a trip through an audio editor.
    ///
    /// Pure and static: given a rate and a spec it produces the same samples every time, so the
    /// envelope maths is checkable from a terminal.
    /// </summary>
    public static class ToneBank
    {
        public const int SampleRate = 48000;

        /// <summary>One partial of a sound: a pitch glide with its own envelope and level.</summary>
        public struct Partial
        {
            public float StartHz;
            public float EndHz;
            public float Level;
            /// <summary>Seconds. Together these must not exceed the clip length.</summary>
            public float AttackSec;
            public float DecaySec;
            public float SustainLevel;
            public float ReleaseSec;
            /// <summary>0 is a sine, 1 is a triangle. Nothing here needs a saw or a square.</summary>
            public float Triangle;
            public float DelaySec;
        }

        public struct Spec
        {
            public float LengthSec;
            public Partial[] Partials;
        }

        /// <summary>
        /// The specs. Deliberately short -- nothing over 700ms.
        ///
        /// A UI sound that outlasts the gesture it belongs to stops being feedback and starts
        /// being a noise the cook is waiting out, and in a kitchen where they also need to hear
        /// a pan, that is worse than silence.
        /// </summary>
        public static Spec SpecFor(Sfx sound)
        {
            switch (sound)
            {
                // A soft two-partial blip, landing with the toast's 420ms slide.
                case Sfx.MessagePop:
                    return new Spec
                    {
                        LengthSec = 0.22f,
                        Partials = new[]
                        {
                            Tone(520f, 660f, 0.30f, 0.008f, 0.09f, 0.0f, 0.10f, 0.25f, 0f),
                            Tone(1040f, 1320f, 0.10f, 0.006f, 0.06f, 0.0f, 0.08f, 0.0f, 0.01f),
                        },
                    };

                // A rising perfect fifth. The one unambiguously happy interval, and short.
                case Sfx.GoodCut:
                    return new Spec
                    {
                        LengthSec = 0.34f,
                        Partials = new[]
                        {
                            Tone(784f, 784f, 0.30f, 0.004f, 0.12f, 0.0f, 0.14f, 0.15f, 0f),
                            Tone(1175f, 1175f, 0.26f, 0.004f, 0.16f, 0.0f, 0.16f, 0.15f, 0.07f),
                        },
                    };

                // Climbing arpeggio. The pitch rises with the multiplier, which is the point:
                // the cook hears the combo grow without reading it.
                case Sfx.ComboUp:
                    return new Spec
                    {
                        LengthSec = 0.40f,
                        Partials = new[]
                        {
                            Tone(659f, 659f, 0.22f, 0.003f, 0.08f, 0f, 0.06f, 0.2f, 0f),
                            Tone(880f, 880f, 0.22f, 0.003f, 0.08f, 0f, 0.06f, 0.2f, 0.07f),
                            Tone(1046f, 1046f, 0.24f, 0.003f, 0.14f, 0f, 0.12f, 0.2f, 0.14f),
                        },
                    };

                // A falling minor third. Disappointed, not punishing.
                case Sfx.StreakBreak:
                    return new Spec
                    {
                        LengthSec = 0.36f,
                        Partials = new[]
                        {
                            Tone(440f, 392f, 0.26f, 0.006f, 0.18f, 0f, 0.14f, 0.35f, 0f),
                            Tone(220f, 196f, 0.12f, 0.006f, 0.20f, 0f, 0.14f, 0.5f, 0f),
                        },
                    };

                // Two pulses. Never the only signal for anything that matters -- a warning is
                // always paired with a visible cue, because a cook with a pan going may not
                // hear this at all.
                case Sfx.Warning:
                    return new Spec
                    {
                        LengthSec = 0.46f,
                        Partials = new[]
                        {
                            Tone(392f, 392f, 0.30f, 0.005f, 0.10f, 0f, 0.05f, 0.4f, 0f),
                            Tone(392f, 392f, 0.30f, 0.005f, 0.10f, 0f, 0.05f, 0.4f, 0.20f),
                        },
                    };

                case Sfx.StepComplete:
                    return new Spec
                    {
                        LengthSec = 0.42f,
                        Partials = new[]
                        {
                            Tone(523f, 523f, 0.26f, 0.004f, 0.10f, 0f, 0.10f, 0.2f, 0f),
                            Tone(698f, 698f, 0.24f, 0.004f, 0.18f, 0f, 0.16f, 0.2f, 0.09f),
                        },
                    };

                // A short downward glide. Reads as "that one did not count", not as a buzzer.
                case Sfx.PointsDocked:
                    return new Spec
                    {
                        LengthSec = 0.30f,
                        Partials = new[]
                        {
                            Tone(330f, 247f, 0.24f, 0.004f, 0.16f, 0f, 0.10f, 0.45f, 0f),
                        },
                    };

                case Sfx.RankUp:
                    return new Spec
                    {
                        LengthSec = 0.62f,
                        Partials = new[]
                        {
                            Tone(523f, 523f, 0.22f, 0.004f, 0.08f, 0f, 0.06f, 0.15f, 0f),
                            Tone(659f, 659f, 0.22f, 0.004f, 0.08f, 0f, 0.06f, 0.15f, 0.08f),
                            Tone(784f, 784f, 0.22f, 0.004f, 0.08f, 0f, 0.06f, 0.15f, 0.16f),
                            Tone(1046f, 1046f, 0.28f, 0.004f, 0.24f, 0f, 0.20f, 0.15f, 0.24f),
                        },
                    };

                // Tiny and dry. A poke click that rings is a click you hear after your finger
                // has already moved on.
                case Sfx.PokeClick:
                    return new Spec
                    {
                        LengthSec = 0.07f,
                        Partials = new[] { Tone(1200f, 900f, 0.22f, 0.001f, 0.035f, 0f, 0.03f, 0.6f, 0f) },
                    };

                case Sfx.Hover:
                    return new Spec
                    {
                        LengthSec = 0.06f,
                        Partials = new[] { Tone(1600f, 1600f, 0.07f, 0.002f, 0.03f, 0f, 0.025f, 0.5f, 0f) },
                    };

                // Low, slow, and the only sound here that is meant to feel like a door closing.
                case Sfx.SafeModeEnter:
                    return new Spec
                    {
                        LengthSec = 0.70f,
                        Partials = new[]
                        {
                            Tone(294f, 262f, 0.28f, 0.03f, 0.30f, 0.10f, 0.30f, 0.3f, 0f),
                            Tone(147f, 131f, 0.18f, 0.03f, 0.30f, 0.10f, 0.30f, 0.5f, 0f),
                        },
                    };

                default:
                    return new Spec { LengthSec = 0.1f, Partials = new[] { Tone(440f, 440f, 0.2f, 0.005f, 0.05f, 0f, 0.04f, 0f, 0f) } };
            }
        }

        static Partial Tone(float startHz, float endHz, float level, float attack, float decay, float sustain, float release, float triangle, float delay) =>
            new Partial
            {
                StartHz = startHz, EndHz = endHz, Level = level,
                AttackSec = attack, DecaySec = decay, SustainLevel = sustain, ReleaseSec = release,
                Triangle = triangle, DelaySec = delay,
            };

        /// <summary>
        /// Renders a spec to float samples. Pure -- this is the part the tests exercise.
        /// </summary>
        public static float[] Render(Spec spec, int sampleRate = SampleRate)
        {
            var count = Mathf.Max(1, Mathf.CeilToInt(spec.LengthSec * sampleRate));
            var samples = new float[count];
            if (spec.Partials == null) return samples;

            foreach (var partial in spec.Partials)
            {
                // Phase is accumulated rather than computed from t, because the pitch glides.
                // `sin(2*pi*f(t)*t)` with a changing f is not a glide, it is a chirp with the
                // wrong slope and an audible discontinuity at the start.
                var phase = 0.0;
                var delaySamples = Mathf.RoundToInt(partial.DelaySec * sampleRate);

                for (var i = delaySamples; i < count; i++)
                {
                    var local = (i - delaySamples) / (float)sampleRate;
                    var span = Mathf.Max(spec.LengthSec - partial.DelaySec, 1e-4f);
                    var progress = Mathf.Clamp01(local / span);

                    var hz = Mathf.Lerp(partial.StartHz, partial.EndHz, progress);
                    phase += 2.0 * Math.PI * hz / sampleRate;
                    if (phase > 2.0 * Math.PI) phase -= 2.0 * Math.PI;

                    var sine = (float)Math.Sin(phase);
                    // Triangle by folding the sine's own phase: cheaper than a second
                    // oscillator and stays in phase with it, so the blend cannot beat.
                    var triangle = 2f / Mathf.PI * Mathf.Asin(Mathf.Clamp(sine, -1f, 1f));
                    var wave = Mathf.Lerp(sine, triangle, Mathf.Clamp01(partial.Triangle));

                    samples[i] += wave * partial.Level * EnvelopeAt(partial, local);
                }
            }

            // Normalise only if something clipped. Normalising unconditionally would make a
            // quiet sound as loud as a loud one, and the relative levels above are the mix.
            var peak = 0f;
            for (var i = 0; i < count; i++) peak = Mathf.Max(peak, Mathf.Abs(samples[i]));
            if (peak > 1f)
            {
                var gain = 0.98f / peak;
                for (var i = 0; i < count; i++) samples[i] *= gain;
            }

            return samples;
        }

        /// <summary>
        /// ADSR at a point in time, with the release starting where decay ends.
        ///
        /// Exposed so a test can assert the two properties that matter: it starts at zero and
        /// it ends at zero. A non-zero endpoint is a click at the end of every single sound,
        /// and a non-zero start is a click at the beginning of every single sound.
        /// </summary>
        public static float EnvelopeAt(Partial partial, float t)
        {
            if (t < 0f) return 0f;

            var attack = Mathf.Max(partial.AttackSec, 1e-4f);
            if (t < attack) return t / attack;

            var decayEnd = attack + Mathf.Max(partial.DecaySec, 0f);
            if (t < decayEnd)
            {
                var k = (t - attack) / Mathf.Max(partial.DecaySec, 1e-4f);
                return Mathf.Lerp(1f, partial.SustainLevel, k);
            }

            var releaseEnd = decayEnd + Mathf.Max(partial.ReleaseSec, 1e-4f);
            if (t < releaseEnd)
            {
                var k = (t - decayEnd) / Mathf.Max(partial.ReleaseSec, 1e-4f);
                return Mathf.Lerp(partial.SustainLevel, 0f, k);
            }

            return 0f;
        }

        /// <summary>Builds the AudioClip. Mono: these are UI sounds and are positioned by their source.</summary>
        public static AudioClip Build(Sfx sound)
        {
            var spec = SpecFor(sound);
            var samples = Render(spec);
            var clip = AudioClip.Create(sound.ToString(), samples.Length, 1, SampleRate, false);
            clip.SetData(samples, 0);
            return clip;
        }
    }
}
