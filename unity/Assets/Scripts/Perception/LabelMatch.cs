using System;

namespace MRPerception
{
    /// <summary>
    /// Decides whether a recipe's label and a tracked object's label refer to the same thing.
    ///
    /// Exact string equality does not survive contact with two vocabularies. COCO says "bottle";
    /// GPT says "bottle of olive oil". The recipe says "pepper"; GPT says "red bell pepper". All
    /// three pairs are the same object, and comparing with <c>==</c> matches none of them, so
    /// the checklist sits there never ticking while the object is plainly on the counter.
    ///
    /// Two rules, both cheap:
    ///
    ///   <b>Contiguous subsequence.</b> "olive oil" inside "bottle of olive oil".
    ///
    ///   <b>Shared head noun.</b> English compound nouns put the head last -- "red bell PEPPER",
    ///   "frying PAN", "shredded cheddar in a BOWL". Matching on the final token is linguistically
    ///   sound, costs nothing, and catches the overwhelming majority of what a vision model
    ///   actually returns.
    ///
    /// Deliberately not fuzzy-matching on edit distance. "pan" and "pen" are one character apart
    /// and are not remotely the same thing, and a recipe that advances on the wrong object is
    /// worse than one that waits.
    /// </summary>
    public static class LabelMatch
    {
        private static readonly char[] Separators = { ' ', '-', '_', '(', ')', ',', '.', '/' };

        public static bool Matches(string a, string b)
        {
            if (string.IsNullOrWhiteSpace(a) || string.IsNullOrWhiteSpace(b)) return false;
            if (string.Equals(a, b, StringComparison.OrdinalIgnoreCase)) return true;

            string[] ta = Tokenize(a);
            string[] tb = Tokenize(b);
            if (ta.Length == 0 || tb.Length == 0) return false;

            if (IsSubsequence(ta, tb) || IsSubsequence(tb, ta)) return true;

            return string.Equals(ta[ta.Length - 1], tb[tb.Length - 1],
                StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>True when any of <paramref name="candidates"/> matches.</summary>
        public static bool MatchesAny(string[] candidates, string tracked)
        {
            if (candidates == null) return false;
            foreach (string c in candidates)
            {
                if (Matches(c, tracked)) return true;
            }
            return false;
        }

        private static string[] Tokenize(string s)
        {
            string[] raw = s.ToLowerInvariant().Split(Separators, StringSplitOptions.RemoveEmptyEntries);
            int keep = 0;
            for (int i = 0; i < raw.Length; i++)
            {
                // Articles and prepositions are noise: "shredded cheddar in a bowl" should have
                // the head noun "bowl", not "a".
                if (IsNoise(raw[i])) continue;
                raw[keep++] = raw[i];
            }
            if (keep == raw.Length) return raw;
            var trimmed = new string[keep];
            Array.Copy(raw, trimmed, keep);
            return trimmed;
        }

        private static bool IsNoise(string token) => token switch
        {
            "a" or "an" or "the" or "of" or "in" or "on" or "with" or "some" => true,
            _ => false,
        };

        /// <summary>True when <paramref name="needle"/> appears contiguously in <paramref name="hay"/>.</summary>
        private static bool IsSubsequence(string[] needle, string[] hay)
        {
            if (needle.Length == 0 || needle.Length > hay.Length) return false;
            for (int start = 0; start + needle.Length <= hay.Length; start++)
            {
                bool all = true;
                for (int i = 0; i < needle.Length; i++)
                {
                    if (!string.Equals(needle[i], hay[start + i], StringComparison.OrdinalIgnoreCase))
                    {
                        all = false;
                        break;
                    }
                }
                if (all) return true;
            }
            return false;
        }
    }
}
