import asyncio
import io
import unittest

from PIL import Image

from app import main


def png_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class NormalizeUploadTests(unittest.TestCase):
    def test_transparent_reference_lands_on_white(self):
        logo = Image.new("RGBA", (128, 96), (0, 0, 0, 0))
        for x in range(40, 80):
            for y in range(30, 60):
                logo.putpixel((x, y), (10, 20, 200, 255))
        normalized, width, height = main.normalize_upload(png_bytes(logo), "reference")
        with Image.open(io.BytesIO(normalized)) as result:
            self.assertEqual(result.mode, "RGB")
            self.assertEqual(result.getpixel((0, 0)), (255, 255, 255))
            self.assertEqual(result.getpixel((50, 40)), (10, 20, 200))
        self.assertEqual((width, height), (128, 96))

    def test_mask_stays_single_channel(self):
        mask = Image.new("RGB", (128, 96), (255, 255, 255))
        normalized, _, _ = main.normalize_upload(png_bytes(mask), "mask")
        with Image.open(io.BytesIO(normalized)) as result:
            self.assertEqual(result.mode, "L")


class GenerateCanvasTests(unittest.TestCase):
    def tearDown(self):
        main.references.clear()
        main.jobs.clear()
        while not main.queue.empty():
            main.queue.get_nowait()

    def _reference(self, width: int, height: int) -> main.Reference:
        reference = main.Reference(
            id="ref-aspect-test", owner="tester", key="unused", kind="reference",
            filename="logo.png", contentType="image/png",
            width=width, height=height, bytes=1024,
        )
        main.references[reference.id] = reference
        return reference

    def test_edit_canvas_follows_reference_when_dims_omitted(self):
        reference = self._reference(1500, 400)
        request = main.GenerationRequest(prompt="navy background", referenceId=reference.id)
        job = asyncio.run(main.generate(request, x_burtson_owner="tester"))
        self.assertEqual((job["request"]["width"], job["request"]["height"]), (1344, 384))

    def test_explicit_dims_stay_authoritative(self):
        reference = self._reference(1500, 400)
        request = main.GenerationRequest(
            prompt="navy background", referenceId=reference.id, width=768, height=1344,
        )
        job = asyncio.run(main.generate(request, x_burtson_owner="tester"))
        self.assertEqual((job["request"]["width"], job["request"]["height"]), (768, 1344))

    def test_generation_without_reference_defaults_to_square(self):
        request = main.GenerationRequest(prompt="a brass robot")
        job = asyncio.run(main.generate(request, x_burtson_owner="tester"))
        self.assertEqual((job["request"]["width"], job["request"]["height"]), (1024, 1024))


if __name__ == "__main__":
    unittest.main()
