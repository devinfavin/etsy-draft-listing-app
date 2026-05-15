**What's new in this version**

- **Fixed: Etsy drafts failing with "contains invalid characters."** Etsy's materials field only accepts plain letters, numbers, and spaces. When the AI generated something like "100% Cotton" or "Cotton/Polyester Blend," Etsy rejected the whole draft. Materials are now automatically cleaned up before being sent, and the AI is instructed to write them in the allowed format from the start.

- **Cleaner punctuation in generated text.** Em-dashes (—), en-dashes (–), and smart/curly quotes are now replaced with plain ASCII versions across titles, descriptions, bullet specs, and image alt text — keeping listings consistent and avoiding any other character-validation surprises from Etsy.
