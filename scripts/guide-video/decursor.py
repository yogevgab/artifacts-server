"""Remove the real mouse pointer baked into the step-1 screenshot (bbox found by inspection)."""
import os
import cv2, numpy as np
G = os.environ.get("GUIDE_SHOTS", "guide-shots")  # folder of the original PNG screenshots
im = cv2.imread(f"{G}/01-add-custom-connector.png")
x0, y0, x1, y1 = 1268, 145, 1302, 184
roi = im[y0:y1, x0:x1]
gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
mask = np.zeros(im.shape[:2], np.uint8)
m = (gray < 150).astype(np.uint8) * 255  # the black arrow body
m = cv2.dilate(m, np.ones((5, 5), np.uint8), iterations=2)  # include its white outline
mask[y0:y1, x0:x1] = m
out = cv2.inpaint(im, mask, 4, cv2.INPAINT_TELEA)
cv2.imwrite(f"{G}/01-add-custom-connector-clean.png", out)
print("ok")
