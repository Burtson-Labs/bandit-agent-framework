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


if __name__ == "__main__":
    unittest.main()
