# Development frames

Drop JPEGs or PNGs of a countertop in here.

`ImageFolderFrameSource` loads them in the Editor and the simulator, where there are no
passthrough cameras, and plays one every 3 seconds. Everything downstream runs identically to
the headset: downscale to 512px, JPEG encode under 60KB, POST to the server, parse, vote across
three results, score, toast.

That is the whole point of the folder. Without it the coach path can only be exercised by
putting the headset on, which is a ten-minute loop for a bug in a JSON field name.

Nothing here ships — the folder sits outside `Assets/` and is loaded by absolute path at
development time only.

Good frames to use: a pan on a hob, a chopping board mid-prep, ingredients on a counter. A
photo of your actual kitchen works better than a stock image, because that is what the model
will see.
