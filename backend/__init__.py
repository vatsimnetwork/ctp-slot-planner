from flask import Flask, jsonify
app = Flask(__name__)

@app.route('/tracks/', methods=['GET'])
def tracks():
    # Placeholder data format based on the one used in the frontend
    t = [
        {'id': 'A', 'col': 'black', 'dep': 'KJFK', 'arr': 'EGLL', 'value': 30, 'cap': 550},
        {'id': 'B', 'col': 'black', 'dep': 'KBOS', 'arr': 'EHAM', 'value': 30, 'cap': 30},
        {'id': 'C', 'col': 'black', 'dep': 'CYYC', 'arr': 'EDDF', 'value': 11, 'cap': 30},
    ]
    return jsonify(t)

if __name__ == '__main__':
    app.run()