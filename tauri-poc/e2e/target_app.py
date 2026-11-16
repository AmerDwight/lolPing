"""A plain window that logs every mouse button and key it gets, so the e2e test can tell what reached the app under
lolPing. usage: target_app.py <log file>"""
import sys
import time
import tkinter as tk

TITLE = 'lolPing e2e target'
log = open(sys.argv[1], 'a', buffering=1, encoding='utf-8')


def note(text):
    log.write(f'{time.time():.3f} {text}\n')


root = tk.Tk()
root.title(TITLE)
root.geometry('520x380+60+60')
root.bind('<ButtonPress>', lambda e: note(f'down {e.num} {e.x_root} {e.y_root}'))
root.bind('<ButtonRelease>', lambda e: note(f'up {e.num} {e.x_root} {e.y_root}'))
root.bind('<KeyPress>', lambda e: note(f'key {e.keysym}'))
root.bind('<FocusIn>', lambda e: note('focus in'))
root.bind('<FocusOut>', lambda e: note('focus out'))
tk.Label(root, text='e2e target').pack(expand=True, fill='both')
note('started')
root.mainloop()
