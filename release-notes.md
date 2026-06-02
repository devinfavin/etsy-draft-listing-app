**What's new in this version**

- **Fixed a draft-creation failure caused by a non-numeric saved category.** If a store had a stuck "category" default that wasn't a real Etsy category number (for example, the word "book"), creating a draft would fail with `Expected int value for 'taxonomy_id' (got string)`. The app now cleans up bad category defaults automatically on launch, prompts you to pick a real Etsy category on Step 5 when one is missing, and shows a readable error if anything non-numeric ever slips through again.
