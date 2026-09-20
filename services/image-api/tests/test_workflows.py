import unittest

from app.workflows import flux_workflow, validate_dimension


class WorkflowTests(unittest.TestCase):
    def test_prompt_and_dimensions_flow_into_workflow(self):
        workflow = flux_workflow("a brass robot", 1024, 768, 4, 42)
        self.assertEqual(workflow["2"]["inputs"]["text"], "a brass robot")
        self.assertEqual(workflow["4"]["inputs"]["height"], 768)
        self.assertEqual(workflow["5"]["inputs"]["seed"], 42)

    def test_dimensions_must_be_safe_multiples(self):
        with self.assertRaises(ValueError):
            validate_dimension(1000)

    def test_reference_builds_img2img_workflow(self):
        workflow = flux_workflow(
            "make the logo blue", 1024, 1024, 4, 42,
            reference_name="reference.png", strength=0.35,
        )
        self.assertEqual(workflow["4"]["class_type"], "LoadImage")
        self.assertEqual(workflow["8"]["inputs"]["width"], 1024)
        self.assertEqual(workflow["5"]["inputs"]["latent_image"], ["9", 0])
        self.assertEqual(workflow["5"]["inputs"]["denoise"], 0.35)

    def test_mask_builds_inpaint_workflow(self):
        workflow = flux_workflow(
            "replace the selected area", 768, 1344, 4, 42,
            reference_name="reference.png", mask_name="mask.png",
        )
        self.assertEqual(workflow["12"]["class_type"], "ImageToMask")
        self.assertEqual(workflow["13"]["class_type"], "VAEEncodeForInpaint")
        self.assertEqual(workflow["5"]["inputs"]["latent_image"], ["13", 0])


if __name__ == "__main__":
    unittest.main()
